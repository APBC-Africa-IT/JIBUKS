/**
 * Estimates (pro-formas): estimate_status, POST /invoices/{id}/accept and
 * /decline, converting, and GET /invoices?estimate_status=&q=.
 *
 * A pro-forma posts nothing, so one can be dated in the past to expire.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import { estimateStatus } from "@jibuks/domain";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
import { authHeader } from "./testAuth.js";

const app = await listen(createApp());
const today = todayInNairobi();

afterAll(async () => {
  await closePool();
});

async function auth() {
  return { Authorization: await authHeader() };
}

async function post(path: string, body: object = {}) {
  const response = await request(app).post(`/api/v1${path}`).set(await auth()).send(body);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
}

async function rawPost(path: string, body: object = {}) {
  return request(app).post(`/api/v1${path}`).set(await auth()).send(body);
}

async function get(path: string) {
  return request(app).get(`/api/v1${path}`).set(await auth());
}

interface Fixture {
  customerId: string;
  customerName: string;
  arAccountId: string;
  salesAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const account = async (type: string) =>
    (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Estimate ${type}`, type })).id as string;
  const customerName = `Estimate Customer ${randomUUID().slice(0, 8)}`;
  return {
    customerId: (await post("/customers", { name: customerName })).id,
    customerName,
    arAccountId: await account("ASSET"),
    salesAccountId: await account("INCOME"),
  };
}

async function estimate(f: Fixture, extra: Record<string, unknown> = {}) {
  return post("/invoices", {
    clientUuid: randomUUID(),
    kind: "PROFORMA",
    customerId: f.customerId,
    receivableAccountId: f.arAccountId,
    issueDate: today,
    lines: [{ description: "Bridal package", quantity: 1, unitPriceMinor: 4500000, incomeAccountId: f.salesAccountId }],
    issue: true,
    ...extra,
  });
}

async function listIds(query: string) {
  return (await get(`/invoices?${query}`)).body.data.map((i: { id: string }) => i.id);
}

describe("estimate_status", () => {
  it("is DRAFT, then PENDING once issued; null on other documents", async () => {
    const f = await makeFixture();

    const draft = await estimate(f, { issue: false });
    const issued = await post(`/invoices/${draft.id}/issue`);
    const invoice = await post("/invoices", {
      clientUuid: randomUUID(),
      customerId: f.customerId,
      receivableAccountId: f.arAccountId,
      issueDate: today,
      lines: [{ description: "Goods", quantity: 1, unitPriceMinor: 100, incomeAccountId: f.salesAccountId }],
    });

    expect(draft.estimate_status).toBe("DRAFT");
    expect(issued).toMatchObject({ status: "ISSUED", number: expect.stringMatching(/^PF-/), estimate_status: "PENDING" });
    expect(invoice.estimate_status).toBeNull();
  });

  it("is EXPIRED past its valid-until date with no answer", async () => {
    const f = await makeFixture();

    const old = await estimate(f, { issueDate: "2026-09-01", dueDate: "2026-09-15" });

    expect(old.estimate_status).toBe("EXPIRED");
  });

  it("follows the rules in order: cancelled, converted, draft, answer, expired, pending", () => {
    expect(estimateStatus("CANCELLED", "ACCEPTED", null, true, today)).toBe("CANCELLED");
    expect(estimateStatus("ISSUED", "ACCEPTED", null, true, today)).toBe("CONVERTED");
    expect(estimateStatus("DRAFT", null, null, true, today)).toBe("CONVERTED");
    expect(estimateStatus("DRAFT", null, "2020-01-01", false, today)).toBe("DRAFT");
    expect(estimateStatus("ISSUED", "DECLINED", "2020-01-01", false, today)).toBe("DECLINED");
    expect(estimateStatus("ISSUED", null, "2020-01-01", false, today)).toBe("EXPIRED");
    expect(estimateStatus("ISSUED", null, today, false, today)).toBe("PENDING");
  });
});

describe("POST /api/v1/invoices/{id}/accept and /decline", () => {
  it("records the customer's answer, and a later answer replaces it", async () => {
    const f = await makeFixture();
    const pf = await estimate(f);

    const accepted = await post(`/invoices/${pf.id}/accept`, { note: "Accepted by phone" });
    const declined = await post(`/invoices/${pf.id}/decline`);

    expect(accepted).toMatchObject({
      estimate_status: "ACCEPTED",
      estimate_response: "ACCEPTED",
      estimate_response_note: "Accepted by phone",
      estimate_responded_at: expect.any(String),
      estimate_responded_by: expect.any(String),
    });
    expect(declined).toMatchObject({ estimate_status: "DECLINED", estimate_response_note: null });
  });

  it("an accepted estimate stays ACCEPTED after its valid-until date", async () => {
    const f = await makeFixture();
    const old = await estimate(f, { issueDate: "2026-09-01", dueDate: "2026-09-15" });

    const accepted = await post(`/invoices/${old.id}/accept`);

    expect(accepted.estimate_status).toBe("ACCEPTED");
  });

  it("refuses drafts, converted or cancelled estimates, and documents that aren't estimates", async () => {
    const f = await makeFixture();
    const draft = await estimate(f, { issue: false });
    const converted = await estimate(f);
    await post(`/invoices/${converted.id}/convert`, { clientUuid: randomUUID() });
    const cancelled = await estimate(f);
    await post(`/invoices/${cancelled.id}/cancel`, { reason: "Customer went elsewhere" });
    const invoice = await post("/invoices", {
      clientUuid: randomUUID(),
      customerId: f.customerId,
      receivableAccountId: f.arAccountId,
      issueDate: today,
      lines: [{ description: "Goods", quantity: 1, unitPriceMinor: 100, incomeAccountId: f.salesAccountId }],
    });

    const onDraft = await rawPost(`/invoices/${draft.id}/accept`);
    const onConverted = await rawPost(`/invoices/${converted.id}/decline`);
    const onCancelled = await rawPost(`/invoices/${cancelled.id}/accept`);
    const onInvoice = await rawPost(`/invoices/${invoice.id}/accept`);
    const unknown = await rawPost(`/invoices/${randomUUID()}/accept`);
    const longNote = await rawPost(`/invoices/${draft.id}/accept`, { note: "x".repeat(501) });

    expect([onDraft.status, onDraft.body.title]).toEqual([422, "INVOICE_INVALID_STATE"]);
    expect(onConverted.body.title).toBe("INVOICE_INVALID_STATE");
    expect(onCancelled.body.title).toBe("INVOICE_INVALID_STATE");
    expect(onInvoice.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(longNote.status).toBe(400);
  });
});

describe("converting", () => {
  it("shows CONVERTED, with the invoice made from it", async () => {
    const f = await makeFixture();
    const pf = await estimate(f);
    await post(`/invoices/${pf.id}/accept`);

    const invoice = await post(`/invoices/${pf.id}/convert`, { clientUuid: randomUUID() });
    const after = (await get(`/invoices/${pf.id}`)).body;

    expect(invoice.proforma_id).toBe(pf.id);
    expect(after).toMatchObject({ estimate_status: "CONVERTED", converted_invoice_id: invoice.id });
  });

  it("refuses a declined estimate until it is accepted", async () => {
    const f = await makeFixture();
    const pf = await estimate(f);
    await post(`/invoices/${pf.id}/decline`, { note: "Price too high" });

    const refused = await rawPost(`/invoices/${pf.id}/convert`, { clientUuid: randomUUID() });
    await post(`/invoices/${pf.id}/accept`);
    const converted = await rawPost(`/invoices/${pf.id}/convert`, { clientUuid: randomUUID() });

    expect([refused.status, refused.body.title]).toEqual([422, "INVOICE_INVALID_STATE"]);
    expect(converted.status).toBe(201);
  });
});

describe("GET /api/v1/invoices?estimate_status=&q=", () => {
  it("filters estimates by status", async () => {
    const f = await makeFixture();
    const draft = await estimate(f, { issue: false });
    const pending = await estimate(f);
    const accepted = await estimate(f);
    await post(`/invoices/${accepted.id}/accept`);
    const declined = await estimate(f);
    await post(`/invoices/${declined.id}/decline`);
    const expired = await estimate(f, { issueDate: "2026-09-01", dueDate: "2026-09-15" });
    const converted = await estimate(f);
    await post(`/invoices/${converted.id}/convert`, { clientUuid: randomUUID() });
    const cancelled = await estimate(f);
    await post(`/invoices/${cancelled.id}/cancel`, { reason: "No longer needed" });
    const by = (status: string) => listIds(`customer_id=${f.customerId}&estimate_status=${status}`);

    expect(await by("DRAFT")).toEqual([draft.id]);
    expect(await by("PENDING")).toEqual([pending.id]);
    expect(await by("ACCEPTED")).toEqual([accepted.id]);
    expect(await by("DECLINED")).toEqual([declined.id]);
    expect(await by("EXPIRED")).toEqual([expired.id]);
    expect(await by("CONVERTED")).toEqual([converted.id]);
    expect(await by("CANCELLED")).toEqual([cancelled.id]);
  });

  it("searches by customer name, number or reference", async () => {
    const f = await makeFixture();
    const pf = await estimate(f, { reference: `REF-${randomUUID().slice(0, 6)}` });

    expect(await listIds(`kind=PROFORMA&q=${encodeURIComponent(f.customerName.toLowerCase())}`)).toEqual([pf.id]);
    expect(await listIds(`q=${pf.number}`)).toEqual([pf.id]);
    expect(await listIds(`q=${pf.reference}`)).toEqual([pf.id]);
    expect((await get("/invoices?estimate_status=SOMETHING")).status).toBe(400);
  });
});
