/**
 * Payments repository.
 *
 * The ONLY file permitted to write raw SQL against `payments` (AD-02).
 * Every state change is audit-logged in the same transaction (FR-AUD-01).
 * Changes driven by an M-Pesa callback have no signed-in user; they are
 * attributed to the user who initiated the payment.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";

export type PaymentStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface PaymentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_uuid: string;
  readonly provider: "MPESA";
  readonly method: "STK_PUSH";
  readonly status: PaymentStatus;
  readonly amount_minor: string; // bigint
  readonly currency: string;
  readonly phone: string;
  readonly account_reference: string;
  readonly description: string | null;
  readonly received_account_id: string;
  readonly credit_account_id: string;
  readonly customer_id: string | null;
  readonly invoice_id: string | null;
  readonly tax_account_id: string | null;
  readonly tax_amount_minor: string; // bigint
  readonly merchant_request_id: string | null;
  readonly checkout_request_id: string | null;
  readonly callback_token_hash: string;
  readonly result_code: string | null;
  readonly result_desc: string | null;
  readonly mpesa_receipt_number: string | null;
  readonly transaction_date: string | null;
  readonly callback_payload: unknown;
  readonly journal_id: string | null;
  readonly posting_error: string | null;
  readonly initiated_by: string;
  readonly created_at: string;
  readonly completed_at: string | null;
}

export interface InsertPaymentInput {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly phone: string;
  readonly accountReference: string;
  readonly description?: string;
  readonly receivedAccountId: string;
  readonly creditAccountId: string;
  readonly customerId?: string;
  readonly invoiceId?: string;
  readonly taxAccountId?: string;
  readonly taxAmountMinor?: number;
  readonly callbackTokenHash: string;
}

/** Never expose the token hash or Safaricom's raw payload to API clients. */
function auditView(row: PaymentRow) {
  const { callback_token_hash, callback_payload, ...rest } = row;
  return rest;
}

export async function insertPayment(input: InsertPaymentInput, audit: AuditContext): Promise<PaymentRow> {
  return withTenant(input.tenantId, async (client) => {
    const result = await client.query<PaymentRow>(
      `INSERT INTO payments
         (id, tenant_id, client_uuid, provider, method, amount_minor, currency, phone, account_reference,
          description, received_account_id, credit_account_id, customer_id, tax_account_id, tax_amount_minor,
          callback_token_hash, initiated_by, invoice_id)
       VALUES ($1, $2, $3, 'MPESA', 'STK_PUSH', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        randomUUID(),
        input.tenantId,
        input.clientUuid,
        input.amountMinor,
        input.currency,
        input.phone,
        input.accountReference,
        input.description ?? null,
        input.receivedAccountId,
        input.creditAccountId,
        input.customerId ?? null,
        input.taxAccountId ?? null,
        input.taxAmountMinor ?? 0,
        input.callbackTokenHash,
        audit.actorUserId,
        input.invoiceId ?? null,
      ],
    );
    const payment = result.rows[0]!;
    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "payment",
      entityId: payment.id,
      afterState: auditView(payment),
      context: audit,
    });
    return payment;
  });
}

export async function getPayment(tenantId: string, paymentId: string): Promise<PaymentRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<PaymentRow>(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
    return result.rows[0] ?? null;
  });
}

export async function listPayments(tenantId: string): Promise<PaymentRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<PaymentRow>(`SELECT * FROM payments ORDER BY created_at DESC LIMIT 200`);
    return result.rows;
  });
}

/** Records Daraja's acceptance of the push -- the ids its callback will carry. */
export async function markPushed(
  tenantId: string,
  paymentId: string,
  merchantRequestId: string,
  checkoutRequestId: string,
): Promise<PaymentRow> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<PaymentRow>(
      `UPDATE payments SET merchant_request_id = $2, checkout_request_id = $3 WHERE id = $1 RETURNING *`,
      [paymentId, merchantRequestId, checkoutRequestId],
    );
    return result.rows[0]!;
  });
}

/**
 * Attaches Safaricom's request ids to a payment that never learned them --
 * its push timed out (outcome unknown), or the callback beat markPushed.
 * Safaricom calling back proves the push arrived, so a payment marked
 * FAILED without a result code (our own "no response" / provider-error
 * verdict, never Safaricom's) goes back to PENDING to take the callback.
 * Returns null if the payment already has ids or a Safaricom result.
 */
export async function adoptCheckoutRequest(
  tenantId: string,
  paymentId: string,
  merchantRequestId: string | null,
  checkoutRequestId: string,
): Promise<PaymentRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<PaymentRow>(
      `SELECT * FROM payments
        WHERE id = $1 AND checkout_request_id IS NULL
          AND (status = 'PENDING' OR (status = 'FAILED' AND result_code IS NULL))
        FOR UPDATE`,
      [paymentId],
    );
    const existing = before.rows[0];
    if (!existing) {
      return null;
    }
    const result = await client.query<PaymentRow>(
      `UPDATE payments
          SET merchant_request_id = $2, checkout_request_id = $3,
              status = 'PENDING', result_desc = NULL, completed_at = NULL
        WHERE id = $1
       RETURNING *`,
      [paymentId, merchantRequestId, checkoutRequestId],
    );
    const payment = result.rows[0]!;
    if (existing.status !== "PENDING") {
      await recordAuditLog(client, {
        tenantId,
        action: "UPDATE",
        entityType: "payment",
        entityId: payment.id,
        beforeState: auditView(existing),
        afterState: auditView(payment),
        context: { actorUserId: existing.initiated_by },
      });
    }
    return payment;
  });
}

/** Keeps a successful callback while its confirmation is outstanding. */
export async function storeCallbackPayload(tenantId: string, paymentId: string, payload: unknown): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(`UPDATE payments SET callback_payload = $2 WHERE id = $1 AND status = 'PENDING'`, [
      paymentId,
      JSON.stringify(payload),
    ]);
  });
}

export interface CompletionInput {
  readonly status: Exclude<PaymentStatus, "PENDING">;
  readonly resultCode: string | null;
  readonly resultDesc: string | null;
  readonly receiptNumber?: string;
  readonly transactionDate?: string;
  readonly callbackPayload?: unknown;
}

/**
 * Moves a payment out of PENDING -- at most once. Returns null if it had
 * already left PENDING, so exactly one of any concurrent callers (duplicate
 * callbacks, a status poll) goes on to post the journal.
 */
export async function completeIfPending(
  tenantId: string,
  paymentId: string,
  input: CompletionInput,
): Promise<PaymentRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<PaymentRow>(
      `SELECT * FROM payments WHERE id = $1 AND status = 'PENDING' FOR UPDATE`,
      [paymentId],
    );
    const existing = before.rows[0];
    if (!existing) {
      return null;
    }
    const result = await client.query<PaymentRow>(
      `UPDATE payments
          SET status = $2, result_code = $3, result_desc = $4,
              mpesa_receipt_number = COALESCE($5, mpesa_receipt_number),
              transaction_date = COALESCE($6, transaction_date),
              callback_payload = COALESCE($7, callback_payload),
              completed_at = now()
        WHERE id = $1
       RETURNING *`,
      [
        paymentId,
        input.status,
        input.resultCode,
        input.resultDesc,
        input.receiptNumber ?? null,
        input.transactionDate ?? null,
        input.callbackPayload !== undefined ? JSON.stringify(input.callbackPayload) : null,
      ],
    );
    const payment = result.rows[0]!;
    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "payment",
      entityId: payment.id,
      beforeState: auditView(existing),
      afterState: auditView(payment),
      context: { actorUserId: existing.initiated_by },
    });
    return payment;
  });
}

/**
 * Records the outcome of posting a payment. A failure never overwrites a
 * journal already linked -- a repost racing the original posting (or
 * another repost) can't undo the one that succeeded.
 */
export async function setPostingResult(
  tenantId: string,
  paymentId: string,
  journalId: string | null,
  postingError: string | null,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    if (journalId !== null) {
      await client.query(`UPDATE payments SET journal_id = $2, posting_error = NULL WHERE id = $1`, [
        paymentId,
        journalId,
      ]);
    } else {
      await client.query(`UPDATE payments SET posting_error = $2 WHERE id = $1 AND journal_id IS NULL`, [
        paymentId,
        postingError,
      ]);
    }
  });
}
