/**
 * HTTP-level tests for the periods module.
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

describe("POST /api/v1/periods", () => {
  it("creates a period and returns pure calendar dates with no time component", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const response = await request(app)
      .post("/api/v1/periods")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ startDate: "2026-08-01", endDate: "2026-08-31" });

    expect(response.status).toBe(201);
    expect(response.body.start_date).toBe("2026-08-01");
    expect(response.body.end_date).toBe("2026-08-31");
    expect(response.body.status).toBe("OPEN");
  });

  it("rejects an end_date before start_date", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const response = await request(app)
      .post("/api/v1/periods")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ startDate: "2026-08-31", endDate: "2026-08-01" });

    expect(response.status).not.toBe(201);
  });
});

describe("GET /api/v1/periods", () => {
  it("lists only periods belonging to the requesting tenant", async () => {
    const tenantA = await makeTenantWithUser();
    const tenantB = await makeTenantWithUser();

    await request(app)
      .post("/api/v1/periods")
      .set("X-Tenant-Id", tenantA.tenantId)
      .set("X-Actor-User-Id", tenantA.userId)
      .send({ startDate: "2026-08-01", endDate: "2026-08-31" });

    await request(app)
      .post("/api/v1/periods")
      .set("X-Tenant-Id", tenantB.tenantId)
      .set("X-Actor-User-Id", tenantB.userId)
      .send({ startDate: "2026-08-01", endDate: "2026-08-31" });

    const response = await request(app).get("/api/v1/periods").set("X-Tenant-Id", tenantA.tenantId);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });
});

describe("POST /api/v1/periods/:id/close and /reopen", () => {
  it("closes an open period, then reopens it, resetting closed_by and closed_at", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const created = await request(app)
      .post("/api/v1/periods")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ startDate: "2026-08-01", endDate: "2026-08-31" });

    const periodId = created.body.id as string;

    const closed = await request(app)
      .post(`/api/v1/periods/${periodId}/close`)
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId);

    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("CLOSED");
    expect(closed.body.closed_by).toBe(userId);
    expect(closed.body.closed_at).toBeTruthy();

    const reopened = await request(app)
      .post(`/api/v1/periods/${periodId}/reopen`)
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId);

    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe("OPEN");
    expect(reopened.body.closed_by).toBeNull();
    expect(reopened.body.closed_at).toBeNull();
  });

  it("rejects closing a period that is already closed", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const created = await request(app)
      .post("/api/v1/periods")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ startDate: "2026-08-01", endDate: "2026-08-31" });

    const periodId = created.body.id as string;

    await request(app)
      .post(`/api/v1/periods/${periodId}/close`)
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId);

    const secondClose = await request(app)
      .post(`/api/v1/periods/${periodId}/close`)
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId);

    expect(secondClose.status).toBe(422);
    expect(secondClose.body.title).toBe("PERIOD_LOCKED");
  });

  it("rejects reopening a period that is already open", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const created = await request(app)
      .post("/api/v1/periods")
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId)
      .send({ startDate: "2026-08-01", endDate: "2026-08-31" });

    const periodId = created.body.id as string;

    const response = await request(app)
      .post(`/api/v1/periods/${periodId}/reopen`)
      .set("X-Tenant-Id", tenantId)
      .set("X-Actor-User-Id", userId);

    expect(response.status).toBe(422);
    expect(response.body.title).toBe("PERIOD_LOCKED");
  });
});