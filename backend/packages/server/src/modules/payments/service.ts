/**
 * Payments service -- M-Pesa STK push collection (FR-PAY-01..07).
 *
 * Flow:
 *   1. initiateStkPush: validate, record a PENDING payment, ask Daraja to
 *      prompt the customer's phone. Each payment gets its own secret
 *      callback URL.
 *   2. handleStkCallback: Safaricom reports the outcome. A failure or
 *      cancellation is recorded as-is. A reported success is NOT trusted
 *      on its own -- Daraja doesn't sign callbacks -- so it is confirmed
 *      with an STK status query first (settle).
 *   3. settle: on confirmed success, mark SUCCEEDED and post
 *      Dr received account / Cr credit account (and Cr tax account for any
 *      VAT included) through the journals module.
 *
 * A payment is never reported as succeeded without Safaricom confirming it
 * (FR-PAY-07). If the confirmation query can't be made right away, the
 * payment stays PENDING with the callback kept; GET /payments/{id}
 * retries the confirmation.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError, isUuid, type CurrencyCode } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as customersService from "../customers/service.js";
import * as journalsService from "../journals/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as repository from "./repository.js";
import type { PaymentRow } from "./repository.js";
import { getDarajaClient } from "./daraja.js";

/** M-Pesa result code for "cancelled by the user" on the phone prompt. */
const RESULT_CANCELLED_BY_USER = "1032";

/** A PENDING payment older than this is re-checked with Daraja when read. */
const RECHECK_AFTER_MS = 60_000;

const DEFAULT_ACCOUNT_REFERENCE = "JIBUKS";

/** What API clients see: never the callback secret's hash or Safaricom's raw payload. */
export type PaymentView = Omit<PaymentRow, "callback_token_hash" | "callback_payload">;

function toView(row: PaymentRow): PaymentView {
  const { callback_token_hash, callback_payload, ...view } = row;
  return view;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The path Safaricom calls back. Deliberately free of words like "mpesa"
 * or "safaricom", which Daraja is known to reject in callback URLs. */
export function callbackPath(tenantId: string, paymentId: string, token: string): string {
  return `/api/v1/hooks/stk/${tenantId}/${paymentId}/${token}`;
}

async function assertPostableAccount(tenantId: string, accountId: string): Promise<void> {
  const account = await accountsService.getAccount(tenantId, accountId);
  if (!account.is_active) {
    throw new DomainError("ACCOUNT_INACTIVE", `Account ${accountId} is inactive`);
  }
  if (!account.is_postable) {
    throw new DomainError("ACCOUNT_NOT_POSTABLE", `Account ${accountId} is a header account and can't be posted to`);
  }
}

export interface InitiateStkPushRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly phone: string;
  readonly amountMinor: number;
  readonly currency: "KES";
  /** Defaults to the tenant's M-Pesa account (created if missing). */
  readonly receivedAccountId?: string;
  readonly creditAccountId: string;
  readonly customerId?: string;
  /** Output VAT included in amountMinor; both or neither. */
  readonly taxAccountId?: string;
  readonly taxAmountMinor?: number;
  readonly accountReference?: string;
  readonly description?: string;
}

export async function initiateStkPush(request: InitiateStkPushRequest, audit: AuditContext): Promise<PaymentView> {
  const daraja = getDarajaClient(); // 503 before anything is recorded

  // Resolved by system key, not code, and created here if missing -- so a
  // Cashier (no accounts:create) can collect in a business onboarded
  // before the M-Pesa starter account existed.
  const receivedAccountId =
    request.receivedAccountId ?? (await accountsService.getOrCreateMpesaAccount(request.tenantId, audit)).id;

  // Validate everything the eventual journal needs NOW, so a customer is
  // never charged for a payment that then can't be posted.
  await assertPostableAccount(request.tenantId, receivedAccountId);
  await assertPostableAccount(request.tenantId, request.creditAccountId);
  if (request.taxAccountId) {
    await assertPostableAccount(request.tenantId, request.taxAccountId);
  }
  if (request.customerId) {
    await customersService.getCustomer(request.tenantId, request.customerId);
  }

  const token = randomBytes(32).toString("base64url");
  const accountReference = request.accountReference ?? DEFAULT_ACCOUNT_REFERENCE;
  const payment = await repository.insertPayment(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      amountMinor: request.amountMinor,
      currency: request.currency,
      phone: request.phone,
      accountReference,
      ...(request.description !== undefined ? { description: request.description } : {}),
      receivedAccountId,
      creditAccountId: request.creditAccountId,
      ...(request.customerId !== undefined ? { customerId: request.customerId } : {}),
      ...(request.taxAccountId !== undefined
        ? { taxAccountId: request.taxAccountId, taxAmountMinor: request.taxAmountMinor ?? 0 }
        : {}),
      callbackTokenHash: hashToken(token),
    },
    audit,
  );

  try {
    const pushed = await daraja.stkPush({
      phone: request.phone,
      amountShillings: request.amountMinor / 100,
      accountReference,
      transactionDesc: (request.description ?? "Payment").slice(0, 13),
      callbackUrl: `${daraja.callbackBaseUrl}${callbackPath(request.tenantId, payment.id, token)}`,
    });
    const updated = await repository.markPushed(
      request.tenantId,
      payment.id,
      pushed.merchantRequestId,
      pushed.checkoutRequestId,
    );
    return toView(updated);
  } catch (err) {
    // Nothing reached the customer's phone -- record the failure (the row
    // stays visible for audit) and report it honestly.
    const message = err instanceof Error ? err.message : String(err);
    await repository.completeIfPending(request.tenantId, payment.id, {
      status: "FAILED",
      resultCode: null,
      resultDesc: message,
    });
    throw err;
  }
}

interface StkCallback {
  readonly MerchantRequestID?: string;
  readonly CheckoutRequestID?: string;
  readonly ResultCode?: number | string;
  readonly ResultDesc?: string;
  readonly CallbackMetadata?: { readonly Item?: ReadonlyArray<{ Name: string; Value?: unknown }> };
}

function extractCallback(body: unknown): StkCallback | null {
  const cb = (body as { Body?: { stkCallback?: StkCallback } } | null)?.Body?.stkCallback;
  return cb && typeof cb === "object" ? cb : null;
}

function metadataValue(cb: StkCallback, name: string): unknown {
  return cb.CallbackMetadata?.Item?.find((item) => item.Name === name)?.Value;
}

/** Daraja's TransactionDate (e.g. 20260915102115, East Africa Time) -> "2026-09-15". */
function toAccountingDate(raw: unknown): string | null {
  const digits = String(raw ?? "");
  if (!/^\d{14}$/.test(digits)) {
    return null;
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function failureStatus(resultCode: string): "CANCELLED" | "FAILED" {
  return resultCode === RESULT_CANCELLED_BY_USER ? "CANCELLED" : "FAILED";
}

/**
 * Handles Safaricom's STK callback. Unknown payment, wrong secret or a
 * mismatched CheckoutRequestID all look the same from outside: 404.
 * Callbacks for a payment that has already left PENDING are acknowledged
 * and ignored, so Safaricom retries and replays change nothing.
 */
export async function handleStkCallback(
  tenantId: string,
  paymentId: string,
  token: string,
  body: unknown,
): Promise<void> {
  const notFound = new DomainError("PAYMENT_NOT_FOUND", "Payment not found");
  if (!isUuid(tenantId) || !isUuid(paymentId)) {
    throw notFound;
  }
  const payment = await repository.getPayment(tenantId, paymentId);
  if (!payment || !tokenMatches(token, payment.callback_token_hash)) {
    throw notFound;
  }
  const cb = extractCallback(body);
  if (!cb || !payment.checkout_request_id || cb.CheckoutRequestID !== payment.checkout_request_id) {
    throw notFound;
  }
  if (payment.status !== "PENDING") {
    return;
  }

  const resultCode = String(cb.ResultCode ?? "");
  if (resultCode !== "0") {
    await repository.completeIfPending(tenantId, paymentId, {
      status: failureStatus(resultCode),
      resultCode,
      resultDesc: cb.ResultDesc ?? null,
      callbackPayload: body,
    });
    return;
  }

  await repository.storeCallbackPayload(tenantId, paymentId, body);
  await settle(tenantId, paymentId);
}

/**
 * Confirms a PENDING payment with Daraja and applies the outcome. Safe to
 * call repeatedly and concurrently. Leaves the payment PENDING when Daraja
 * can't answer yet, or reports success before its callback has delivered
 * the receipt number.
 */
async function settle(tenantId: string, paymentId: string): Promise<void> {
  const payment = await repository.getPayment(tenantId, paymentId);
  if (!payment || payment.status !== "PENDING" || !payment.checkout_request_id) {
    return;
  }

  let query;
  try {
    query = await getDarajaClient().stkQuery(payment.checkout_request_id);
  } catch (err) {
    console.error(`Could not confirm payment ${paymentId} with M-Pesa; will retry on next read:`, err);
    return;
  }
  if (query.state === "pending") {
    return;
  }
  if (query.resultCode !== "0") {
    await repository.completeIfPending(tenantId, paymentId, {
      status: failureStatus(query.resultCode),
      resultCode: query.resultCode,
      resultDesc: query.resultDesc,
    });
    return;
  }

  const cb = extractCallback(payment.callback_payload);
  if (!cb) {
    return; // Confirmed, but the receipt only arrives with the callback.
  }
  const receipt = metadataValue(cb, "MpesaReceiptNumber");
  const transactionDate = toAccountingDate(metadataValue(cb, "TransactionDate")) ?? todayInNairobi();
  const completed = await repository.completeIfPending(tenantId, paymentId, {
    status: "SUCCEEDED",
    resultCode: "0",
    resultDesc: query.resultDesc,
    ...(typeof receipt === "string" ? { receiptNumber: receipt } : {}),
    transactionDate,
  });
  if (!completed) {
    return; // Someone else settled it first.
  }
  await postToLedger(completed, Number(metadataValue(cb, "Amount")));
}

async function postToLedger(payment: PaymentRow, paidShillings: number): Promise<void> {
  const amountMinor = Number(payment.amount_minor);
  if (Math.round(paidShillings * 100) !== amountMinor) {
    await repository.setPostingResult(
      payment.tenant_id,
      payment.id,
      null,
      `M-Pesa reported KES ${paidShillings} but KES ${amountMinor / 100} was requested; not posted, needs review`,
    );
    return;
  }

  const description = payment.description ?? `M-Pesa payment from ${payment.phone}`;
  const taxAmountMinor = Number(payment.tax_amount_minor);
  try {
    const journal = await journalsService.createJournal(
      {
        tenantId: payment.tenant_id,
        // The payment's own id: posting the same payment twice is then
        // impossible at the database level (unique client_uuid).
        clientUuid: payment.id,
        date: payment.transaction_date!,
        currency: payment.currency as CurrencyCode,
        description,
        ...(payment.mpesa_receipt_number ? { reference: payment.mpesa_receipt_number } : {}),
        source: "PAYMENT",
        lines: [
          { accountId: payment.received_account_id, debitMinor: amountMinor, creditMinor: 0, narrative: description },
          {
            accountId: payment.credit_account_id,
            debitMinor: 0,
            creditMinor: amountMinor - taxAmountMinor,
            narrative: description,
            ...(payment.customer_id ? { customerId: payment.customer_id } : {}),
          },
          ...(taxAmountMinor > 0
            ? [{ accountId: payment.tax_account_id!, debitMinor: 0, creditMinor: taxAmountMinor, narrative: "Sales tax" }]
            : []),
        ],
      },
      { actorUserId: payment.initiated_by },
    );
    await repository.setPostingResult(payment.tenant_id, payment.id, journal.id, null);
  } catch (err) {
    // The money has arrived regardless -- record why it couldn't be posted
    // (e.g. no open period for the date) rather than losing the payment.
    const message = err instanceof DomainError ? err.message : "Unexpected error while posting";
    if (!(err instanceof DomainError)) {
      console.error(`Posting payment ${payment.id} failed:`, err);
    }
    await repository.setPostingResult(payment.tenant_id, payment.id, null, message);
  }
}

export async function getPayment(tenantId: string, paymentId: string): Promise<PaymentView> {
  if (!isUuid(paymentId)) {
    throw new DomainError("PAYMENT_NOT_FOUND", `Payment ${paymentId} not found`);
  }
  let payment = await repository.getPayment(tenantId, paymentId);
  if (!payment) {
    throw new DomainError("PAYMENT_NOT_FOUND", `Payment ${paymentId} not found`);
  }
  // Covers a lost or delayed callback: re-check a stale PENDING payment.
  if (payment.status === "PENDING" && Date.now() - new Date(payment.created_at).getTime() > RECHECK_AFTER_MS) {
    try {
      await settle(tenantId, paymentId);
      payment = (await repository.getPayment(tenantId, paymentId))!;
    } catch (err) {
      if (!(err instanceof DomainError && err.code === "PAYMENTS_NOT_CONFIGURED")) {
        throw err;
      }
    }
  }
  return toView(payment);
}

export async function listPayments(tenantId: string): Promise<PaymentView[]> {
  const rows = await repository.listPayments(tenantId);
  return rows.map(toView);
}
