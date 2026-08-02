/**
 * HTTP-level tests for the periods module, authenticated via real Auth0
 * tokens (see testAuth.ts).
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

/** Distinct date ranges per test avoid overlapping-period ambiguity across
 * repeated runs against the same persistent, shared TEST_TENANT_ID. */
function uniqueDateRange(): { startDate: string; endDate: string } {
  const year = 2030 + Math.floor(Math.random() * 900);
  return { startDate: `${year}-01-01`, endDate: `${year}-01-31` };
}

describe("POST /api/v1/periods", () => {
  it("creates a period and returns pure calendar dates with no time component", async () => {
    const { startDate, endDate } = uniqueDateRange();

    const response = await request(app)
      .post("/api/v1/periods")
      .set("Authorization", await authHeader())
      .send({ startDate, endDate });

    expect(response.status).toBe(201);
    expect(response.body.start_date).toBe(startDate);
    expect(response.body.end_date).toBe(endDate);
    expect(response.body.status).toBe("OPEN");
  });

  it("rejects an end_date before start_date", async () => {
    const { startDate, endDate } = uniqueDateRange();

    const response = await request(app)
      .post("/api/v1/periods")
      .set("Authorization", await authHeader())
      .send({ startDate: endDate, endDate: startDate });

    expect(response.status).not.toBe(201);
  });

  it("rejects a request with no Authorization header", async () => {
    const { startDate, endDate } = uniqueDateRange();

    const response = await request(app).post("/api/v1/periods").send({ startDate, endDate });

    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/periods", () => {
  it("lists periods for the authenticated tenant, excluding a second, separately-seeded tenant", async () => {
    const { startDate, endDate } = uniqueDateRange();

    const created = await request(app)
      .post("/api/v1/periods")
      .set("Authorization", await authHeader())
      .send({ startDate, endDate });

    const otherTenantId = randomUUID();
    await withoutTenant(async (client) => {
      await client.query(
        `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
        [otherTenantId, `Other Tenant ${otherTenantId}`],
      );
    });
    await withTenant(otherTenantId, async (client) => {
      await client.query(`INSERT INTO periods (tenant_id, start_date, end_date) VALUES ($1, $2, $3)`, [
        otherTenantId,
        startDate,
        endDate,
      ]);
    });

    const response = await request(app).get("/api/v1/periods").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.data.some((p: { id: string }) => p.id === created.body.id)).toBe(true);
    expect(response.body.data.every((p: { tenant_id: string }) => p.tenant_id === TEST_TENANT_ID)).toBe(true);
  });
});

describe("POST /api/v1/periods/:id/close and /reopen", () => {
  it("closes an open period, then reopens it, resetting closed_by and closed_at", async () => {
    const { startDate, endDate } = uniqueDateRange();

    const created = await request(app)
      .post("/api/v1/periods")
      .set("Authorization", await authHeader())
      .send({ startDate, endDate });

    const periodId = created.body.id as string;

    const closed = await request(app)
      .post(`/api/v1/periods/${periodId}/close`)
      .set("Authorization", await authHeader());

    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("CLOSED");
    expect(closed.body.closed_by).toBeTruthy();
    expect(closed.body.closed_at).toBeTruthy();

    const reopened = await request(app)
      .post(`/api/v1/periods/${periodId}/reopen`)
      .set("Authorization", await authHeader());

    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe("OPEN");
    expect(reopened.body.closed_by).toBeNull();
    expect(reopened.body.closed_at).toBeNull();
  });

  it("rejects closing a period that is already closed", async () => {
    const { startDate, endDate } = uniqueDateRange();

    const created = await request(app)
      .post("/api/v1/periods")
      .set("Authorization", await authHeader())
      .send({ startDate, endDate });

    const periodId = created.body.id as string;

    await request(app).post(`/api/v1/periods/${periodId}/close`).set("Authorization", await authHeader());

    const secondClose = await request(app)
      .post(`/api/v1/periods/${periodId}/close`)
      .set("Authorization", await authHeader());

    expect(secondClose.status).toBe(422);
    expect(secondClose.body.title).toBe("PERIOD_LOCKED");
  });

  it("rejects reopening a period that is already open", async () => {
    const { startDate, endDate } = uniqueDateRange();

    const created = await request(app)
      .post("/api/v1/periods")
      .set("Authorization", await authHeader())
      .send({ startDate, endDate });

    const periodId = created.body.id as string;

    const response = await request(app)
      .post(`/api/v1/periods/${periodId}/reopen`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(422);
    expect(response.body.title).toBe("PERIOD_LOCKED");
  });
});