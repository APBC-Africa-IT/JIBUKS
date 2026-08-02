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

const app = createApp();

afterAll(async () => {
  await closePool();
});

interface Fixture {
  tenantId: string;
  userId: string;
  cashAccountId: string;
  salesAccountId: string;
}

async function makeFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();

  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [tenantId, `Tenant ${tenantId}`],
    );
  });

  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name, is_super_admin) VALUES ($1, $2, $3, 'Test User', false)`,
      [userId, tenantId, `test|${userId}`],
    );
    await client.query(
      `INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, '2026-08-01', '2026-08-31')`,
      [tenantId],
    );
  });

  const cash = await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '1000', 'Cash', 'ASSET') RETURNING id`,
      [tenantId],
    );
    return result.rows[0]!.id as string;
  });

  const sales = await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '4000', 'Sales', 'INCOME') RETURNING id`,
      [tenantId],
    );
    return result.rows[0]!.id as string;
  });

  return {
    tenantId,
    userId,
    cashAccountId: cash,
    salesAccountId: sales,
  };
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
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send(balancedJournalBody(fixture));

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("POSTED");
    expect(response.body.lines).toHaveLength(2);
  });

  it("rejects an unbalanced journal with a precise 422 identifying the imbalance", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/journals")
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
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

  it("rejects a journal with no period covering the posting date", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .post("/api/v1/journals")
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send(balancedJournalBody(fixture, { date: "2099-01-01" }));

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("PERIOD_NOT_FOUND");
  });

  it("rejects a journal referencing an account from a different tenant", async () => {
    const fixtureA = await makeFixture();
    const fixtureB = await makeFixture();

    const response = await request(app)
      .post("/api/v1/journals")
      .set("X-Tenant-Id", fixtureA.tenantId)
      .set("X-Actor-User-Id", fixtureA.userId)
      .send(
        balancedJournalBody(fixtureA, {
          lines: [
            { accountId: fixtureB.cashAccountId, debitMinor: 1000, creditMinor: 0 },
            { accountId: fixtureA.salesAccountId, debitMinor: 0, creditMinor: 1000 },
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
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send(balancedJournalBody(fixture));

    const journalId = response.body.id as string;

    const auditRows = await withTenant(fixture.tenantId, async (client) => {
      const result = await client.query(`SELECT action FROM audit_logs WHERE entity_id = $1`, [journalId]);
      return result.rows;
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe("CREATE");
  });
});

describe("GET /api/v1/journals", () => {
  it("lists only journals belonging to the requesting tenant", async () => {
    const fixtureA = await makeFixture();
    const fixtureB = await makeFixture();

    await request(app)
      .post("/api/v1/journals")
      .set("X-Tenant-Id", fixtureA.tenantId)
      .set("X-Actor-User-Id", fixtureA.userId)
      .send(balancedJournalBody(fixtureA));

    await request(app)
      .post("/api/v1/journals")
      .set("X-Tenant-Id", fixtureB.tenantId)
      .set("X-Actor-User-Id", fixtureB.userId)
      .send(balancedJournalBody(fixtureB));

    const response = await request(app).get("/api/v1/journals").set("X-Tenant-Id", fixtureA.tenantId);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });
});

describe("GET /api/v1/journals/:id", () => {
  it("returns the journal with its lines", async () => {
    const fixture = await makeFixture();

    const created = await request(app)
      .post("/api/v1/journals")
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send(balancedJournalBody(fixture));

    const response = await request(app)
      .get(`/api/v1/journals/${created.body.id}`)
      .set("X-Tenant-Id", fixture.tenantId);

    expect(response.status).toBe(200);
    expect(response.body.lines).toHaveLength(2);
  });

  it("returns 404 for a journal that does not exist", async () => {
    const fixture = await makeFixture();

    const response = await request(app)
      .get(`/api/v1/journals/${randomUUID()}`)
      .set("X-Tenant-Id", fixture.tenantId);

    expect(response.status).toBe(404);
  });
});

describe("POST /api/v1/journals/:id/reverse (FR-ACC-02)", () => {
  it("reverses a posted journal, swapping debits and credits", async () => {
    const fixture = await makeFixture();

    const created = await request(app)
      .post("/api/v1/journals")
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send(balancedJournalBody(fixture));

    const response = await request(app)
      .post(`/api/v1/journals/${created.body.id}/reverse`)
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
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
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send(balancedJournalBody(fixture));

    await request(app)
      .post(`/api/v1/journals/${created.body.id}/reverse`)
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send({ reason: "Testing reversal" });

    const original = await request(app)
      .get(`/api/v1/journals/${created.body.id}`)
      .set("X-Tenant-Id", fixture.tenantId);

    expect(original.body.status).toBe("POSTED");
    expect(original.body.description).toBe("Cash sale");
    expect(original.body.reversal_of_journal_id).toBeNull();
  });

  it("rejects reversing the same journal twice", async () => {
    const fixture = await makeFixture();

    const created = await request(app)
      .post("/api/v1/journals")
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send(balancedJournalBody(fixture));

    await request(app)
      .post(`/api/v1/journals/${created.body.id}/reverse`)
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send({ reason: "First reversal" });

    const secondAttempt = await request(app)
      .post(`/api/v1/journals/${created.body.id}/reverse`)
      .set("X-Tenant-Id", fixture.tenantId)
      .set("X-Actor-User-Id", fixture.userId)
      .send({ reason: "Second reversal" });

    expect(secondAttempt.status).toBe(422);
    expect(secondAttempt.body.title).toBe("JOURNAL_ALREADY_REVERSED");
  });
});