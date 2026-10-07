/**
 * GET /tenant -- the caller's own business, incl. plan_tier (FR-MIC-08).
 * PATCH /tenant -- the Owner sets the business's tax PIN.
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

describe("PATCH /api/v1/tenant", () => {
  it("sets the business's tax PIN (upper-cased), and null clears it", async () => {
    const patch = async (body: object) =>
      request(app).patch("/api/v1/tenant").set("Authorization", await authHeader()).send(body);

    const set = await patch({ taxIdentifier: " p051234567x " });
    const read = await request(app).get("/api/v1/tenant").set("Authorization", await authHeader());
    const cleared = await patch({ taxIdentifier: null });

    expect(set.status).toBe(200);
    expect(set.body.tax_identifier).toBe("P051234567X");
    expect(read.body.tax_identifier).toBe("P051234567X");
    expect(cleared.body.tax_identifier).toBeNull();
  });

  it("rejects an empty body or a malformed PIN with 400", async () => {
    const empty = await request(app).patch("/api/v1/tenant").set("Authorization", await authHeader()).send({});
    const bad = await request(app)
      .patch("/api/v1/tenant")
      .set("Authorization", await authHeader())
      .send({ taxIdentifier: "P05*123" });

    expect(empty.status).toBe(400);
    expect(bad.status).toBe(400);
  });
});
