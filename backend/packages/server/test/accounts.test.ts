/**
 * HTTP-level tests for the accounts module, now authenticated via real
 * Auth0 tokens (see testAuth.ts) instead of X-Tenant-Id/X-Actor-User-Id
 * headers. accounts was the first module switched over to requireRealIdentity.
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

function uniqueCode(): string {
  return randomUUID().slice(0, 8);
}

describe("POST /api/v1/accounts", () => {
  it("creates an account and returns 201 with the full row", async () => {
    const code = uniqueCode();

    const response = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code, name: "Cash", type: "ASSET" });

    expect(response.status).toBe(201);
    expect(response.body.code).toBe(code);
    expect(response.body.name).toBe("Cash");
    expect(response.body.type).toBe("ASSET");
    expect(response.body.tenant_id).toBe(TEST_TENANT_ID);
    expect(response.body.is_active).toBe(true);
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app)
      .post("/api/v1/accounts")
      .send({ code: uniqueCode(), name: "Cash", type: "ASSET" });

    expect(response.status).toBe(401);
  });

  it("rejects an invalid account type with a precise 400 validation error", async () => {
    const response = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: uniqueCode(), name: "Cash", type: "NOT_A_TYPE" });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
    expect(response.body.errors[0].path).toBe("type");
  });

  it("rejects a duplicate account code within the same tenant with a precise 409 conflict", async () => {
    const code = uniqueCode();

    await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code, name: "Bank", type: "ASSET" });

    const second = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code, name: "Bank Duplicate", type: "ASSET" });

    expect(second.status).toBe(409);
    expect(second.body.title).toBe("DUPLICATE_VALUE");
  });

  it("records an audit log entry for the created account", async () => {
    const response = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: uniqueCode(), name: "Sales", type: "INCOME" });

    const accountId = response.body.id as string;

    const auditRows = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query(`SELECT action, entity_id FROM audit_logs WHERE entity_id = $1`, [
        accountId,
      ]);
      return result.rows;
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe("CREATE");
  });
});

describe("GET /api/v1/accounts", () => {
  it("lists accounts for the authenticated tenant, excluding a second, separately-seeded tenant", async () => {
    const code = uniqueCode();

    await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code, name: "Cash Own Tenant", type: "ASSET" });

    // A second tenant, seeded directly -- there is no real login flow to
    // authenticate as an arbitrary second tenant in this test setup.
    const otherTenantId = randomUUID();
    await withoutTenant(async (client) => {
      await client.query(
        `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
        [otherTenantId, `Other Tenant ${otherTenantId}`],
      );
    });
    await withTenant(otherTenantId, async (client) => {
      await client.query(`INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, $2, 'Other Cash', 'ASSET')`, [
        otherTenantId,
        code, // same code is fine -- uniqueness is per tenant
      ]);
    });

    const response = await request(app).get("/api/v1/accounts").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.data.some((a: { code: string }) => a.code === code)).toBe(true);
    // The other tenant's account must never appear, however many rows exist.
    expect(response.body.data.every((a: { tenant_id: string }) => a.tenant_id === TEST_TENANT_ID)).toBe(true);
  });
});

describe("GET /api/v1/accounts/:id", () => {
  it("returns 404 for an account that does not exist", async () => {
    const response = await request(app)
      .get(`/api/v1/accounts/${randomUUID()}`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("POST /api/v1/accounts/:id/deactivate", () => {
  it("deactivates an account, per FR-COA-03 (deactivate, never delete)", async () => {
    const created = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: uniqueCode(), name: "Rent", type: "EXPENSE" });

    const accountId = created.body.id as string;

    const response = await request(app)
      .post(`/api/v1/accounts/${accountId}/deactivate`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.is_active).toBe(false);

    const stillExists = await request(app)
      .get(`/api/v1/accounts/${accountId}`)
      .set("Authorization", await authHeader());
    expect(stillExists.status).toBe(200);
    expect(stillExists.body.is_active).toBe(false);
  });
});

describe("POST /api/v1/accounts/:id/reactivate", () => {
  it("reactivates a previously deactivated account", async () => {
    const created = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: uniqueCode(), name: "Utilities", type: "EXPENSE" });

    const accountId = created.body.id as string;

    await request(app).post(`/api/v1/accounts/${accountId}/deactivate`).set("Authorization", await authHeader());

    const reactivated = await request(app)
      .post(`/api/v1/accounts/${accountId}/reactivate`)
      .set("Authorization", await authHeader());

    expect(reactivated.status).toBe(200);
    expect(reactivated.body.is_active).toBe(true);
  });

  it("returns 404 when reactivating an account that does not exist", async () => {
    const response = await request(app)
      .post(`/api/v1/accounts/${randomUUID()}/reactivate`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("ACCOUNT_NOT_FOUND");
  });

  it("records an audit log entry for the reactivation, distinct from the deactivation entry", async () => {
    const created = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", await authHeader())
      .send({ code: uniqueCode(), name: "Marketing", type: "EXPENSE" });

    const accountId = created.body.id as string;

    await request(app).post(`/api/v1/accounts/${accountId}/deactivate`).set("Authorization", await authHeader());
    await request(app).post(`/api/v1/accounts/${accountId}/reactivate`).set("Authorization", await authHeader());

    const auditRows = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query(
        `SELECT action, after_state FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at`,
        [accountId],
      );
      return result.rows;
    });

    expect(auditRows).toHaveLength(3);
    expect(auditRows[1]!.after_state.is_active).toBe(false);
    expect(auditRows[2]!.after_state.is_active).toBe(true);
  });
});