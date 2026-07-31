/**
 * HTTP-level tests for the accounts module, exercising the full stack --
 * middleware, controller, service, repository, Postgres -- through
 * createApp() directly. No real network port; supertest talks to the
 * Express app in-memory.
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

async function makeTenantWithUser(): Promise<{ tenantId: string; userId: string }> {
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
  });

  return { tenantId, userId };
}

describe("POST /api/v1/accounts", () => {
  it("creates an account and returns 201 with the full row", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const response = await request(app)
      .post("/api/v1/accounts")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ code: "1000", name: "Cash", type: "ASSET" });

    expect(response.status).toBe(201);
    expect(response.body.code).toBe("1000");
    expect(response.body.name).toBe("Cash");
    expect(response.body.type).toBe("ASSET");
    expect(response.body.tenant_id).toBe(tenantId);
    expect(response.body.is_active).toBe(true);
  });

  it("rejects a request with no X-Tenant-Id header", async () => {
    const response = await request(app)
      .post("/api/v1/accounts")
      .send({ code: "1000", name: "Cash", type: "ASSET" });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("TENANT_HEADER_MISSING");
  });

  it("rejects an invalid account type with a precise 400 validation error", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const response = await request(app)
      .post("/api/v1/accounts")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ code: "1000", name: "Cash", type: "NOT_A_TYPE" });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
    expect(response.body.errors[0].path).toBe("type");
  });

  it("rejects a duplicate account code within the same tenant with a precise 409 conflict", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    await request(app)
      .post("/api/v1/accounts")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ code: "2000", name: "Bank", type: "ASSET" });

    const second = await request(app)
      .post("/api/v1/accounts")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ code: "2000", name: "Bank Duplicate", type: "ASSET" });

    expect(second.status).toBe(409);
    expect(second.body.title).toBe("DUPLICATE_VALUE");
  });

  it("records an audit log entry for the created account", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const response = await request(app)
      .post("/api/v1/accounts")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ code: "3000", name: "Sales", type: "INCOME" });

    const accountId = response.body.id as string;

    const auditRows = await withTenant(tenantId, async (client) => {
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
  it("lists only accounts belonging to the requesting tenant", async () => {
    const tenantA = await makeTenantWithUser();
    const tenantB = await makeTenantWithUser();

    await request(app)
      .post("/api/v1/accounts")
      .set("X-Tenant-Id", tenantA.tenantId)
      .set("X-Actor-User-Id", tenantA.userId)
      .send({ code: "1000", name: "Cash A", type: "ASSET" });

    await request(app)
      .post("/api/v1/accounts")
      .set("X-Tenant-Id", tenantB.tenantId)
      .set("X-Actor-User-Id", tenantB.userId)
      .send({ code: "1000", name: "Cash B", type: "ASSET" });

    const response = await request(app).get("/api/v1/accounts").set("X-Tenant-Id", tenantA.tenantId);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].name).toBe("Cash A");
  });
});

describe("GET /api/v1/accounts/:id", () => {
  it("returns 404 for an account that does not exist", async () => {
    const { tenantId } = await makeTenantWithUser();

    const response = await request(app)
      .get(`/api/v1/accounts/${randomUUID()}`)
      .set("X-Tenant-Id", tenantId);

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("POST /api/v1/accounts/:id/deactivate", () => {
  it("deactivates an account, per FR-COA-03 (deactivate, never delete)", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const created = await request(app)
      .post("/api/v1/accounts")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ code: "5000", name: "Rent", type: "EXPENSE" });

    const accountId = created.body.id as string;

    const response = await request(app)
      .post(`/api/v1/accounts/${accountId}/deactivate`)
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId);

    expect(response.status).toBe(200);
    expect(response.body.is_active).toBe(false);

    // The row still exists -- confirming deactivation, not deletion.
    const stillExists = await request(app)
      .get(`/api/v1/accounts/${accountId}`)
      .set("X-Tenant-Id", tenantId);
    expect(stillExists.status).toBe(200);
    expect(stillExists.body.is_active).toBe(false);
  });
});