/**
 * Customer communication preferences, the business's customer defaults
 * (/customer-settings) and the Customers to Follow Up report.
 *
 * Defaults are business-wide and other test files create customers at the
 * same time, so payment terms and credit limit defaults are tested on a
 * separately seeded business through the service; over HTTP only the
 * communication defaults (which no other test looks at) are changed.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import * as customersService from "../src/modules/customers/service.js";
import { listen } from "./testServer.js";
import { todayInNairobi } from "../src/modules/periods/service.js";
import { authHeader, TEST_USER_ID } from "./testAuth.js";

const app = await listen(createApp());
const today = todayInNairobi();
const audit = { actorUserId: TEST_USER_ID };

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

async function patch(path: string, body: object) {
  return request(app).patch(`/api/v1${path}`).set(await auth()).send(body);
}

async function get(path: string) {
  return request(app).get(`/api/v1${path}`).set(await auth());
}

async function seedTenant(): Promise<string> {
  const tenantId = randomUUID();
  await withoutTenant(async (client) => {
    await client.query(`INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`, [
      tenantId,
      `Settings Tenant ${tenantId}`,
    ]);
  });
  return tenantId;
}

describe("customer communication preferences", () => {
  it("are set on create and changed with PATCH", async () => {
    const created = await post("/customers", {
      name: `Prefs ${randomUUID().slice(0, 8)}`,
      preferredChannel: "WHATSAPP",
      sendStatements: true,
      paymentReminders: true,
    });

    const updated = await patch(`/customers/${created.id}`, { preferredChannel: null, paymentReminders: false });

    expect(created).toMatchObject({ preferred_channel: "WHATSAPP", send_statements: true, payment_reminders: true });
    expect(updated.body).toMatchObject({ preferred_channel: null, send_statements: true, payment_reminders: false });
    expect((await patch(`/customers/${created.id}`, { preferredChannel: "PIGEON" })).status).toBe(400);
  });
});

describe("customer defaults", () => {
  it("fill in what a new customer leaves out; what it states wins", async () => {
    const tenantId = await seedTenant();
    await customersService.updateCustomerSettings(
      tenantId,
      { paymentTermsDays: 30, creditLimitMinor: 5000000, preferredChannel: "SMS", sendStatements: true, paymentReminders: true },
      audit,
    );

    const plain = await customersService.createCustomer({ tenantId, name: "Uses defaults" }, audit);
    const own = await customersService.createCustomer(
      { tenantId, name: "Own terms", paymentTermsDays: 7, creditLimitMinor: 100, preferredChannel: "EMAIL", sendStatements: false },
      audit,
    );

    expect(plain).toMatchObject({
      payment_terms_days: 30,
      credit_limit_minor: "5000000",
      preferred_channel: "SMS",
      send_statements: true,
      payment_reminders: true,
    });
    expect(own).toMatchObject({
      payment_terms_days: 7,
      credit_limit_minor: "100",
      preferred_channel: "EMAIL",
      send_statements: false,
      payment_reminders: true,
    });
  });

  it("don't change existing customers, and null clears a default", async () => {
    const tenantId = await seedTenant();
    await customersService.updateCustomerSettings(tenantId, { paymentTermsDays: 14 }, audit);
    const before = await customersService.createCustomer({ tenantId, name: "Before" }, audit);

    const cleared = await customersService.updateCustomerSettings(tenantId, { paymentTermsDays: null, sendStatements: true }, audit);
    const after = await customersService.createCustomer({ tenantId, name: "After" }, audit);

    expect(cleared).toMatchObject({ payment_terms_days: null, send_statements: true, updated_by: TEST_USER_ID });
    expect((await customersService.getCustomer(tenantId, before.id)).payment_terms_days).toBe(14);
    expect(after).toMatchObject({ payment_terms_days: null, send_statements: true });
  });

  it("are all empty for a business that never saved any", async () => {
    const tenantId = await seedTenant();

    expect(await customersService.getCustomerSettings(tenantId)).toEqual({
      payment_terms_days: null,
      credit_limit_minor: null,
      preferred_channel: null,
      send_statements: false,
      payment_reminders: false,
      updated_by: null,
      updated_at: null,
    });
  });

  it("are read and saved over HTTP", async () => {
    const original = (await get("/customer-settings")).body;

    const saved = await patch("/customer-settings", { preferredChannel: "WHATSAPP" });
    const read = await get("/customer-settings");
    const empty = await patch("/customer-settings", {});
    const bad = await patch("/customer-settings", { paymentTermsDays: -1 });
    await patch("/customer-settings", { preferredChannel: original.preferred_channel });

    expect(saved.status).toBe(200);
    expect(read.body).toMatchObject({ preferred_channel: "WHATSAPP", updated_at: expect.any(String) });
    expect(empty.status).toBe(400);
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/v1/reports/customers-to-follow-up", () => {
  async function fixture() {
    const account = async (type: string) =>
      (await post("/accounts", { code: randomUUID().slice(0, 8), name: `Follow-up ${type}`, type })).id as string;
    return {
      customer: await post("/customers", {
        name: `Follow-up ${randomUUID().slice(0, 8)}`,
        phone: "+254711000000",
        preferredChannel: "SMS",
        paymentReminders: true,
      }),
      quiet: await post("/customers", { name: `On time ${randomUUID().slice(0, 8)}` }),
      arAccountId: await account("ASSET"),
      salesAccountId: await account("INCOME"),
      cashAccountId: await account("ASSET"),
    };
  }

  async function invoice(f: Awaited<ReturnType<typeof fixture>>, customerId: string, amountMinor: number, issueDate: string, dueDate: string) {
    return post("/invoices", {
      clientUuid: randomUUID(),
      customerId,
      receivableAccountId: f.arAccountId,
      issueDate,
      dueDate,
      lines: [{ description: "Goods", quantity: 1, unitPriceMinor: amountMinor, incomeAccountId: f.salesAccountId }],
      issue: true,
    });
  }

  it("lists customers with overdue invoices, most overdue first, with contact details and their last payment", async () => {
    const f = await fixture();
    const older = await invoice(f, f.customer.id, 50000, "2026-09-01", "2026-09-05");
    const newer = await invoice(f, f.customer.id, 30000, "2026-09-10", "2026-09-20");
    await invoice(f, f.customer.id, 10000, today, today); // due today: not overdue
    await invoice(f, f.quiet.id, 10000, today, today);
    const payment = await post("/customer-payments", {
      clientUuid: randomUUID(),
      customerId: f.customer.id,
      amountMinor: 20000,
      date: today,
      receivedAccountId: f.cashAccountId,
      allocations: [{ invoiceId: older.id, amountMinor: 20000 }],
    });

    const report = await get("/reports/customers-to-follow-up");
    const row = report.body.rows.find((r: { customer_id: string }) => r.customer_id === f.customer.id);

    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ as_of: today, currency: "KES", min_days_overdue: 1 });
    expect(row).toMatchObject({
      customer_name: f.customer.name,
      phone: "+254711000000",
      preferred_channel: "SMS",
      payment_reminders: true,
      overdue_minor: "60000",
      overdue_invoice_count: 2,
      oldest_due_date: "2026-09-05",
      balance_minor: "70000",
      last_payment: { date: today, amount_minor: "20000", number: payment.number },
    });
    expect(row.invoices.map((i: { id: string }) => i.id)).toEqual([older.id, newer.id]);
    expect(row.invoices[0]).toMatchObject({ open_minor: "30000", due_date: "2026-09-05" });
    expect(report.body.rows.some((r: { customer_id: string }) => r.customer_id === f.quiet.id)).toBe(false);
    const days = report.body.rows.map((r: { days_overdue: number }) => r.days_overdue);
    expect(days).toEqual([...days].sort((a, b) => b - a));
  });

  it("respects as_of and min_days_overdue", async () => {
    const f = await fixture();
    await invoice(f, f.customer.id, 50000, "2026-09-01", "2026-09-05");

    const early = await get(`/reports/customers-to-follow-up?as_of=2026-09-05`);
    const later = await get(`/reports/customers-to-follow-up?as_of=2026-09-10`);
    const strict = await get(`/reports/customers-to-follow-up?as_of=2026-09-10&min_days_overdue=6`);
    const has = (r: { body: { rows: { customer_id: string }[] } }) => r.body.rows.some((row) => row.customer_id === f.customer.id);

    expect(has(early)).toBe(false);
    expect(has(later)).toBe(true);
    expect(later.body.rows.find((r: { customer_id: string }) => r.customer_id === f.customer.id)).toMatchObject({ days_overdue: 5, last_payment: null });
    expect(has(strict)).toBe(false);
    expect((await get("/reports/customers-to-follow-up?min_days_overdue=0")).status).toBe(400);
  });
});
