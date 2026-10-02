/**
 * M-Pesa STK push collection (FR-PAY-01..07, IF-PAY-01).
 *
 * Daraja is replaced by a scripted fake (setDarajaClientForTesting): the
 * suite never calls Safaricom. Callbacks are replayed in Safaricom's real
 * payload shape straight against the hooks endpoint.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "@jibuks/domain";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import {
  setDarajaClientForTesting,
  type DarajaClient,
  type StkPushRequest,
  type StkQueryResult,
} from "../src/modules/payments/daraja.js";
import * as accountsService from "../src/modules/accounts/service.js";
import { authHeader, TEST_TENANT_ID, TEST_USER_ID } from "./testAuth.js";

const app = createApp();

afterAll(async () => {
  setDarajaClientForTesting(null);
  await closePool();
});

/** Scripted stand-in for Daraja that records what it was asked. */
class FakeDaraja implements DarajaClient {
  readonly callbackBaseUrl = "https://staging.example.test";
  pushes: StkPushRequest[] = [];
  queries: string[] = [];
  pushError: Error | null = null;
  queryResult: StkQueryResult | Error = { state: "complete", resultCode: "0", resultDesc: "Processed successfully" };

  async stkPush(req: StkPushRequest) {
    this.pushes.push(req);
    if (this.pushError) {
      throw this.pushError;
    }
    return { merchantRequestId: `mr-${randomUUID()}`, checkoutRequestId: `ws_CO_${randomUUID()}` };
  }

  async stkQuery(checkoutRequestId: string) {
    this.queries.push(checkoutRequestId);
    if (this.queryResult instanceof Error) {
      throw this.queryResult;
    }
    return this.queryResult;
  }
}

let daraja: FakeDaraja;

beforeEach(() => {
  daraja = new FakeDaraja();
  setDarajaClientForTesting(daraja);
});

interface Fixture {
  mpesaAccountId: string;
  salesAccountId: string;
  arAccountId: string;
  customerId: string;
}

async function makeFixture(): Promise<Fixture> {
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-09-01', '2026-09-30')`,
      [TEST_TENANT_ID],
    );
  });
  const account = async (name: string, type: string) => {
    const response = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: randomUUID().slice(0, 8), name, type });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };
  const customer = await request(app)
    .post("/api/v1/customers")
    .set("Authorization", await authHeader())
    .send({ name: `M-Pesa Customer ${randomUUID().slice(0, 8)}` });
  return {
    mpesaAccountId: await account("M-Pesa Test", "ASSET"),
    salesAccountId: await account("Sales Test", "INCOME"),
    arAccountId: await account("AR Test", "ASSET"),
    customerId: customer.body.id as string,
  };
}

function pushBody(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    phone: "0712345678",
    currency: "KES",
    amountMinor: 150000,
    receivedAccountId: fixture.mpesaAccountId,
    creditAccountId: fixture.salesAccountId,
    ...overrides,
  };
}

async function push(body: object) {
  return request(app).post("/api/v1/payments/mpesa/stk-push").set("Authorization", await authHeader()).send(body);
}

/** The path part of the callback URL handed to Daraja for the last push. */
function lastCallbackPath(): string {
  return daraja.pushes.at(-1)!.callbackUrl.replace(daraja.callbackBaseUrl, "");
}

function successCallback(checkoutRequestId: string, amountShillings: number, receipt = `TIF${randomUUID().slice(0, 7).toUpperCase()}`) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "mr",
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: amountShillings },
            { Name: "MpesaReceiptNumber", Value: receipt },
            { Name: "Balance" },
            { Name: "TransactionDate", Value: 20260915102115 },
            { Name: "PhoneNumber", Value: 254712345678 },
          ],
        },
      },
    },
  };
}

function failureCallback(checkoutRequestId: string, resultCode: number, resultDesc: string) {
  return { Body: { stkCallback: { MerchantRequestID: "mr", CheckoutRequestID: checkoutRequestId, ResultCode: resultCode, ResultDesc: resultDesc } } };
}

async function getPayment(id: string) {
  return request(app).get(`/api/v1/payments/${id}`).set("Authorization", await authHeader());
}

async function journalLines(journalId: string) {
  return withTenant(TEST_TENANT_ID, async (client) => {
    const result = await client.query(
      `SELECT account_id, debit_minor, credit_minor, customer_id FROM journal_lines WHERE journal_id = $1`,
      [journalId],
    );
    return result.rows;
  });
}

describe("POST /api/v1/payments/mpesa/stk-push", () => {
  it("records a PENDING payment and sends Daraja a normalised phone, whole shillings and a secret callback URL", async () => {
    const fixture = await makeFixture();

    const response = await push(pushBody(fixture, { phone: "+254 712 345 678", accountReference: "INV-0042" }));

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "PENDING", provider: "MPESA", method: "STK_PUSH", amount_minor: "150000" });
    expect(response.body.checkout_request_id).toMatch(/^ws_CO_/);
    expect(response.body.callback_token_hash).toBeUndefined();
    expect(daraja.pushes).toHaveLength(1);
    expect(daraja.pushes[0]).toMatchObject({ phone: "254712345678", amountShillings: 1500, accountReference: "INV-0042" });
    expect(lastCallbackPath()).toMatch(
      new RegExp(`^/api/v1/hooks/stk/${TEST_TENANT_ID}/${response.body.id}/[A-Za-z0-9_-]{43}$`),
    );
  });

  it("rejects fractional shillings, a non-Kenyan number and a non-KES currency with 400, without calling Daraja", async () => {
    const fixture = await makeFixture();

    const fractional = await push(pushBody(fixture, { amountMinor: 150050 }));
    const badPhone = await push(pushBody(fixture, { phone: "0812345678" }));
    const usd = await push(pushBody(fixture, { currency: "USD" }));

    expect([fractional.status, badPhone.status, usd.status]).toEqual([400, 400, 400]);
    expect(daraja.pushes).toHaveLength(0);
  });

  it("rejects an unknown credit account with 404 before prompting the customer", async () => {
    const fixture = await makeFixture();

    const response = await push(pushBody(fixture, { creditAccountId: randomUUID() }));

    expect(response.status).toBe(404);
    expect(daraja.pushes).toHaveLength(0);
  });

  it("records the payment as FAILED and answers 502 when Daraja refuses the push", async () => {
    const fixture = await makeFixture();
    daraja.pushError = new DomainError("PAYMENT_PROVIDER_ERROR", "M-Pesa did not accept the payment request: Invalid PhoneNumber");

    const response = await push(pushBody(fixture));
    const list = await request(app).get("/api/v1/payments").set("Authorization", await authHeader());

    expect(response.status).toBe(502);
    expect(response.body.title).toBe("PAYMENT_PROVIDER_ERROR");
    const failed = list.body.data.find((p: { phone: string; status: string; result_desc: string | null }) =>
      p.result_desc?.includes("Invalid PhoneNumber"),
    );
    expect(failed?.status).toBe("FAILED");
  });

  it("receives into the tenant's M-Pesa account when receivedAccountId is omitted", async () => {
    const fixture = await makeFixture();
    const { receivedAccountId: _omitted, ...body } = pushBody(fixture);

    const response = await push(body);

    expect(response.status).toBe(202);
    const mpesa = await accountsService.getOrCreateMpesaAccount(TEST_TENANT_ID, { actorUserId: TEST_USER_ID });
    expect(response.body.received_account_id).toBe(mpesa.id);
    expect(mpesa.system_key).toBe("MPESA");
    expect(mpesa.type).toBe("ASSET");
  });

  it("answers 503 PAYMENTS_NOT_CONFIGURED when M-Pesa isn't configured", async () => {
    const fixture = await makeFixture();
    setDarajaClientForTesting(null);

    const response = await push(pushBody(fixture));

    expect(response.status).toBe(503);
    expect(response.body.title).toBe("PAYMENTS_NOT_CONFIGURED");
  });

  it("never prompts twice for the same clientUuid (FR-PAY-06)", async () => {
    const fixture = await makeFixture();
    const body = pushBody(fixture);
    const key = randomUUID();

    const first = await request(app)
      .post("/api/v1/payments/mpesa/stk-push")
      .set("Authorization", await authHeader())
      .set("Idempotency-Key", key)
      .send(body);
    const replay = await request(app)
      .post("/api/v1/payments/mpesa/stk-push")
      .set("Authorization", await authHeader())
      .set("Idempotency-Key", key)
      .send(body);
    const noKey = await push(body);

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body.id).toBe(first.body.id);
    expect(noKey.status).toBe(409);
    expect(daraja.pushes).toHaveLength(1);
  });
});

describe("POST /api/v1/hooks/stk/... (Safaricom callback)", () => {
  it("confirms a successful callback with Daraja, then posts Dr M-Pesa / Cr the credit account", async () => {
    const fixture = await makeFixture();
    const pushed = await push(pushBody(fixture, { creditAccountId: fixture.arAccountId, customerId: fixture.customerId }));

    // Receipts are unique per tenant and the test tenant persists across runs.
    const receipt = `TIF${randomUUID().slice(0, 7).toUpperCase()}`;
    const callback = await request(app).post(lastCallbackPath()).send(successCallback(pushed.body.checkout_request_id, 1500, receipt));
    const payment = await getPayment(pushed.body.id);

    expect(callback.status).toBe(200);
    expect(callback.body).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    expect(daraja.queries).toEqual([pushed.body.checkout_request_id]);
    expect(payment.body).toMatchObject({
      status: "SUCCEEDED",
      mpesa_receipt_number: receipt,
      transaction_date: "2026-09-15",
      posting_error: null,
    });
    const lines = await journalLines(payment.body.journal_id);
    const debit = lines.find((l) => l.account_id === fixture.mpesaAccountId);
    const credit = lines.find((l) => l.account_id === fixture.arAccountId);
    expect(debit).toMatchObject({ debit_minor: "150000", credit_minor: "0", customer_id: null });
    expect(credit).toMatchObject({ debit_minor: "0", credit_minor: "150000", customer_id: fixture.customerId });
  });

  it("ignores a repeated callback: one journal, no second confirmation", async () => {
    const fixture = await makeFixture();
    const pushed = await push(pushBody(fixture));
    const payload = successCallback(pushed.body.checkout_request_id, 1500);

    await request(app).post(lastCallbackPath()).send(payload);
    const repeat = await request(app).post(lastCallbackPath()).send(payload);

    expect(repeat.status).toBe(200);
    expect(daraja.queries).toHaveLength(1);
    const count = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query(`SELECT count(*)::int AS n FROM journals WHERE client_uuid = $1`, [pushed.body.id]);
      return result.rows[0].n as number;
    });
    expect(count).toBe(1);
  });

  it("rejects a callback with the wrong secret or a mismatched CheckoutRequestID with 404, changing nothing", async () => {
    const fixture = await makeFixture();
    const pushed = await push(pushBody(fixture));
    const goodPath = lastCallbackPath();
    const wrongSecret = goodPath.replace(/[^/]+$/, "A".repeat(43));

    const badSecret = await request(app).post(wrongSecret).send(successCallback(pushed.body.checkout_request_id, 1500));
    const badCheckout = await request(app).post(goodPath).send(successCallback("ws_CO_forged", 1500));
    const payment = await getPayment(pushed.body.id);

    expect(badSecret.status).toBe(404);
    expect(badCheckout.status).toBe(404);
    expect(payment.body.status).toBe("PENDING");
    expect(daraja.queries).toHaveLength(0);
  });

  it("marks CANCELLED when the customer dismisses the prompt, and FAILED for other errors, posting nothing", async () => {
    const fixture = await makeFixture();
    const cancelled = await push(pushBody(fixture));
    await request(app).post(lastCallbackPath()).send(failureCallback(cancelled.body.checkout_request_id, 1032, "Request cancelled by user"));
    const failed = await push(pushBody(fixture));
    await request(app).post(lastCallbackPath()).send(failureCallback(failed.body.checkout_request_id, 1, "The balance is insufficient"));

    const c = await getPayment(cancelled.body.id);
    const f = await getPayment(failed.body.id);

    expect(c.body).toMatchObject({ status: "CANCELLED", result_code: "1032", journal_id: null });
    expect(f.body).toMatchObject({ status: "FAILED", result_code: "1", journal_id: null });
    expect(daraja.queries).toHaveLength(0);
  });

  it("does not trust a success callback that Daraja's status query contradicts", async () => {
    const fixture = await makeFixture();
    const pushed = await push(pushBody(fixture));
    daraja.queryResult = { state: "complete", resultCode: "1032", resultDesc: "Request cancelled by user" };

    await request(app).post(lastCallbackPath()).send(successCallback(pushed.body.checkout_request_id, 1500));
    const payment = await getPayment(pushed.body.id);

    expect(payment.body).toMatchObject({ status: "CANCELLED", journal_id: null });
  });

  it("stays PENDING when confirmation is impossible, then settles on a later read", async () => {
    const fixture = await makeFixture();
    const pushed = await push(pushBody(fixture));
    daraja.queryResult = new DomainError("PAYMENT_PROVIDER_ERROR", "M-Pesa status query failed: timeout");

    await request(app).post(lastCallbackPath()).send(successCallback(pushed.body.checkout_request_id, 1500));
    expect((await getPayment(pushed.body.id)).body.status).toBe("PENDING");

    // Age it past the re-check window, with Daraja reachable again.
    await withTenant(TEST_TENANT_ID, async (client) => {
      await client.query(`UPDATE payments SET created_at = now() - interval '2 minutes' WHERE id = $1`, [pushed.body.id]);
    });
    daraja.queryResult = { state: "complete", resultCode: "0", resultDesc: "Processed successfully" };
    const later = await getPayment(pushed.body.id);

    expect(later.body.status).toBe("SUCCEEDED");
    expect(later.body.journal_id).toBeTruthy();
  });

  it("marks SUCCEEDED but posts nothing when the paid amount differs from the requested amount", async () => {
    const fixture = await makeFixture();
    const pushed = await push(pushBody(fixture));

    await request(app).post(lastCallbackPath()).send(successCallback(pushed.body.checkout_request_id, 1));
    const payment = await getPayment(pushed.body.id);

    expect(payment.body.status).toBe("SUCCEEDED");
    expect(payment.body.journal_id).toBeNull();
    expect(payment.body.posting_error).toContain("needs review");
  });

  it("marks SUCCEEDED with a posting_error when no open period covers the transaction date", async () => {
    const fixture = await makeFixture();
    const pushed = await push(pushBody(fixture));
    const payload = successCallback(pushed.body.checkout_request_id, 1500);
    const item = payload.Body.stkCallback.CallbackMetadata.Item.find((i) => i.Name === "TransactionDate")!;
    item.Value = 19990115102115; // outside every test period

    await request(app).post(lastCallbackPath()).send(payload);
    const payment = await getPayment(pushed.body.id);

    expect(payment.body.status).toBe("SUCCEEDED");
    expect(payment.body.journal_id).toBeNull();
    expect(payment.body.posting_error).toMatch(/period/i);
  });
});

describe("GET /api/v1/payments/:id", () => {
  it("resolves a stale PENDING payment whose callback never came, via Daraja's status query", async () => {
    const fixture = await makeFixture();
    const pushed = await push(pushBody(fixture));
    await withTenant(TEST_TENANT_ID, async (client) => {
      await client.query(`UPDATE payments SET created_at = now() - interval '2 minutes' WHERE id = $1`, [pushed.body.id]);
    });
    daraja.queryResult = { state: "complete", resultCode: "1037", resultDesc: "DS timeout user cannot be reached" };

    const payment = await getPayment(pushed.body.id);

    expect(payment.body).toMatchObject({ status: "FAILED", result_code: "1037" });
  });

  it("returns 404 PAYMENT_NOT_FOUND for an unknown or malformed id", async () => {
    const unknown = await getPayment(randomUUID());
    const malformed = await getPayment("nope");

    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(malformed.body.title).toBe("PAYMENT_NOT_FOUND");
  });
});
