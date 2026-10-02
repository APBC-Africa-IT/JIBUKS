/**
 * GET /tenant -- the caller's own business, incl. plan_tier (FR-MIC-08).
 */

import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { authHeader, TEST_TENANT_ID } from "./testAuth.js";

const app = createApp();

afterAll(async () => {
  await closePool();
});

describe("GET /api/v1/tenant", () => {
  it("returns the caller's own tenant with its plan tier", async () => {
    const response = await request(app).get("/api/v1/tenant").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(TEST_TENANT_ID);
    expect(["STARTER", "GROWTH", "ENTERPRISE"]).toContain(response.body.plan_tier);
    expect(response.body).toHaveProperty("vat_registered");
    expect(response.body).toHaveProperty("base_currency");
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app).get("/api/v1/tenant");
    expect(response.status).toBe(401);
  });
});
