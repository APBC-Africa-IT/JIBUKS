/**
 * HTTP-level tests for the journals module -- the highest-stakes module in
 * the platform. Mirrors the manual proofs done over real curl requests:
 * a balanced journal posts, an unbalanced one is rejected with the exact
 * imbalance identified, reversal works and is idempotent-to-double-call,
 * and tenant isolation holds throughout.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = createApp();

afterAll(async () => {
  await closePool();
});

interface Fixture {
  cashAccountId: string;
  salesAccountId: string;
}

/** Account codes are unique per tenant; the fixture runs repeatedly against
 * the single shared TEST_TENANT_ID, so each account needs a fresh code. */
function uniqueCode(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Seeds a period covering 2026-08 and two postable accounts under the
 * authenticated TEST_TENANT_ID -- the tenant every real-auth request now
 * resolves to. Journals themselves are posted over HTTP with a real token.
 */
async function makeFixture(): Promise<Fixture> {
  return withTenant(TEST_TENANT_ID, async (client) => {
    // Overlapping duplicate periods are harmless: there is no uniqueness or
    // overlap constraint, and findPeriodForDate takes the first match.
    await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-08-01', '2026-08-31')`,
      [TEST_TENANT_ID],
    );

    const cash = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, $2, 'Cash', 'ASSET') RETURNING id`,
      [TEST_TENANT_ID, uniqueCode()],
    );
    const sales = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, $2, 'Sales', 'INCOME') RETURNING id`,
      [TEST_TENANT_ID, uniqueCode()],
    );

    return {
      cashAccountId: cash.rows[0]!.id as string,
      salesAccountId: sales.rows[0]!.id as string,
    };
  });
}

/**
 * Seeds a COMPLETE balanced journal under a fresh, separate tenant -- used
 * to prove tenant isolation holds: this journal must never surface to the
 * authenticated tenant. Everything is inserted in one transaction so the
 * deferred balance trigger (DR-04) sees balanced lines at commit.
 */
async function seedForeignTenantJournal(): Promise<void> {
  const tenantId = randomUUID();
  const userId = randomUUID();

  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [tenantId, `Other Tenant ${tenantId}`],
    );
  });

  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name, is_super_admin) VALUES ($1, $2, $3, 'Other User', false)`,
      [userId, tenantId, `test|${userId}`],
    );
    const period = await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-08-01', '2026-08-31') RETURNING id`,
      [tenantId],
    );
    const cash = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '1000', 'Cash', 'ASSET') RETURNING id`,
      [tenantId],
    );
    const sales = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '4000', 'Sales', 'INCOME') RETURNING id`,
      [tenantId],
    );

    const journalId = randomUUID();
    await client.query(
      `INSERT INTO journals (id, tenant_id, client_uuid, period_id, date, currency, description, source, status, created_by)
       VALUES ($1, $2, $3, $4, '2026-08-15', 'KES', 'Other tenant sale', 'CASHBOOK', 'POSTED', $5)`,
      [journalId, tenantId, randomUUID(), period.rows[0]!.id, userId],
    );
    await client.query(
      `INSERT INTO journal_lines (id, tenant_id, journal_id, account_id, debit_minor, credit_minor) VALUES ($1, $2, $3, $4, 100000, 0)`,
      [randomUUID(), tenantId, journalId, cash.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO journal_lines (id, tenant_id, journal_id, account_id, debit_minor, credit_minor) VALUES ($1, $2, $3, $4, 0, 100000)`,
      [randomUUID(), tenantId, journalId, sales.rows[0]!.id],
    );
  });
}

/**
 * Seeds a single account under a fresh, separate tenant. Used to prove a
 * journal cannot reference another tenant's account.
 */
async function seedForeignTenantAccount(): Promise<string> {
  const tenantId = randomUUID();

  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [tenantId, `Other Tenant ${tenantId}`],
    );
  });

  return withTenant(tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '1000', 'Other Cash', 'ASSET') RETURNING id`,
      [tenantId],
    );
    return result.rows[0]!.id as string;
  });
}

function balancedJournalBody(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    clientUuid: randomUUID(),
    date: "2026-08-15",
    currency: "KES",
    description: "Cash sale",
    source: "CASHBOOK",
    lines: [
      { accountId: fixture.cashAccountId, debitMinor: 100000, creditMinor: 0 },
      { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 100000 },
    ],
    ...overrides,
  };
}

describe("POST /api/v1/journals", () => {
  it("posts a balanced journal and returns it with status POSTED", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(balancedJournalBody(fixture));

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("POSTED");
    expect(response.body.lines).toHaveLength(2);
  });

  it("rejects a request with no Authorization header", async () => {
    const fixture = await makeFixture();

    const response = await request(app).post("/api/v1/journals").send(balancedJournalBody(fixture));

    expect(response.status).toBe(401);
  });

  it("rejects an unbalanced journal with a precise 422 identifying the imbalance", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(
        balancedJournalBody(fixture, {
          lines: [
            { accountId: fixture.cashAccountId, debitMinor: 5000, creditMinor: 0 },
            { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 3000 },
          ],
        }),
      );

    expect(response.status).toBe(422);
    expect(response.body.title).toBe("JOURNAL_UNBALANCED");
    expect(response.body.detail).toContain("5000");
    expect(response.body.detail).toContain("3000");
  });

  it("rejects a line carrying both a customerId and a supplierId with a precise 400 validation error", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(
        balancedJournalBody(fixture, {
          lines: [
            {
              accountId: fixture.cashAccountId,
              debitMinor: 1000,
              creditMinor: 0,
              customerId: randomUUID(),
              supplierId: randomUUID(),
            },
            { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 1000 },
          ],
        }),
      );

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });

  it("rejects a journal with no period covering the posting date", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(balancedJournalBody(fixture, { date: "2099-01-01" }));

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("PERIOD_NOT_FOUND");
  });

  it("rejects a journal referencing an account from a different tenant", async () => {
    const fixture = await makeFixture();
    const foreignAccountId = await seedForeignTenantAccount();

    const response = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(
        balancedJournalBody(fixture, {
          lines: [
            { accountId: foreignAccountId, debitMinor: 1000, creditMinor: 0 },
            { accountId: fixture.salesAccountId, debitMinor: 0, creditMinor: 1000 },
          ],
        }),
      );

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("ACCOUNT_NOT_FOUND");
  });

  it("records an audit log entry for the created journal", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(balancedJournalBody(fixture));

    const journalId = response.body.id as string;

    const auditRows = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query(`SELECT action FROM audit_logs WHERE entity_id = $1`, [journalId]);
      return result.rows;
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe("CREATE");
  });
});

describe("GET /api/v1/journals", () => {
  it("lists journals for the authenticated tenant, excluding a second, separately-seeded tenant", async () => {
    const fixture = await makeFixture();

    const created = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(balancedJournalBody(fixture));

    // A whole journal under a different tenant, seeded directly -- it must
    // never appear in the authenticated tenant's list.
    await seedForeignTenantJournal();

    const response = await request(app).get("/api/v1/journals").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.data.some((j: { id: string }) => j.id === created.body.id)).toBe(true);
    expect(response.body.data.every((j: { tenant_id: string }) => j.tenant_id === TEST_TENANT_ID)).toBe(true);
  });
});

describe("GET /api/v1/journals/:id", () => {
  it("returns the journal with its lines", async () => {
    const fixture = await makeFixture();

    const created = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(balancedJournalBody(fixture));

    const response = await request(app)
      .get(`/api/v1/journals/${created.body.id}`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.lines).toHaveLength(2);
  });

  it("returns 404 for a journal that does not exist", async () => {
    const response = await request(app)
      .get(`/api/v1/journals/${randomUUID()}`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(404);
  });
});

describe("POST /api/v1/journals/:id/reverse (FR-ACC-02)", () => {
  it("reverses a posted journal, swapping debits and credits", async () => {
    const fixture = await makeFixture();

    const created = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(balancedJournalBody(fixture));

    const response = await request(app)
      .post(`/api/v1/journals/${created.body.id}/reverse`)
      .set("Authorization", await authHeader())
      .send({ reason: "Testing reversal" });

    expect(response.status).toBe(201);
    expect(response.body.source).toBe("REVERSAL");
    expect(response.body.reversal_of_journal_id).toBe(created.body.id);

    const cashLine = response.body.lines.find((l: { account_id: string }) => l.account_id === fixture.cashAccountId);
    expect(cashLine.credit_minor).toBe("100000");
    expect(cashLine.debit_minor).toBe("0");
  });

  it("leaves the original journal completely unchanged after reversal", async () => {
    const fixture = await makeFixture();

    const created = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(balancedJournalBody(fixture));

    await request(app)
      .post(`/api/v1/journals/${created.body.id}/reverse`)
      .set("Authorization", await authHeader())
      .send({ reason: "Testing reversal" });

    const original = await request(app)
      .get(`/api/v1/journals/${created.body.id}`)
      .set("Authorization", await authHeader());

    expect(original.body.status).toBe("POSTED");
    expect(original.body.description).toBe("Cash sale");
    expect(original.body.reversal_of_journal_id).toBeNull();
  });

  it("rejects reversing the same journal twice", async () => {
    const fixture = await makeFixture();

    const created = await request(app)
      .post("/api/v1/journals")
      .set("Authorization", await authHeader())
      .send(balancedJournalBody(fixture));

    await request(app)
      .post(`/api/v1/journals/${created.body.id}/reverse`)
      .set("Authorization", await authHeader())
      .send({ reason: "First reversal" });

    const secondAttempt = await request(app)
      .post(`/api/v1/journals/${created.body.id}/reverse`)
      .set("Authorization", await authHeader())
      .send({ reason: "Second reversal" });

    expect(secondAttempt.status).toBe(422);
    expect(secondAttempt.body.title).toBe("JOURNAL_ALREADY_REVERSED");
  });
});