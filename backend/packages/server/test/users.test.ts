/**
 * HTTP-level tests for the users module.
 *
 * POST /users now requires an existing, authenticated caller, and always
 * provisions the new user into the CALLER'S OWN tenant (from the verified
 * token) -- never an arbitrary tenant from the request body. Genuine
 * self-service onboarding (a brand-new tenant's first user, with nobody yet
 * authenticated) is a SEPARATE, public endpoint -- see onboarding.test.ts.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { authHeader, TEST_TENANT_ID, TEST_USER_ID } from "./testAuth.js";

const app = createApp();

afterAll(async () => {
  await closePool();
});

describe("POST /api/v1/users", () => {
  it("provisions a new user into the caller's own tenant, attributed to the caller (not the new user)", async () => {
    const externalIdpSubject = `auth0|${randomUUID()}`;

    const response = await request(app)
      .post("/api/v1/users")
      .set("Authorization", await authHeader())
      .send({ externalIdpSubject, name: "New Teammate", email: "teammate@example.com" });

    expect(response.status).toBe(201);
    expect(response.body.tenant_id).toBe(TEST_TENANT_ID);
    expect(response.body.external_idp_subject).toBe(externalIdpSubject);

    const auditRows = await withTenant(TEST_TENANT_ID, async (client) => {
      const result = await client.query(`SELECT actor_user_id, entity_id FROM audit_logs WHERE entity_id = $1`, [
        response.body.id,
      ]);
      return result.rows;
    });

    expect(auditRows).toHaveLength(1);
    // The AUTHENTICATED CALLER is the actor, not the newly created user.
    expect(auditRows[0]!.actor_user_id).toBe(TEST_USER_ID);
    expect(auditRows[0]!.entity_id).toBe(response.body.id);
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app)
      .post("/api/v1/users")
      .send({ externalIdpSubject: `auth0|${randomUUID()}`, name: "Nobody" });

    expect(response.status).toBe(401);
  });

  it("rejects a duplicate externalIdpSubject with a precise 409 USER_ALREADY_EXISTS", async () => {
    const externalIdpSubject = `auth0|${randomUUID()}`;

    const first = await request(app)
      .post("/api/v1/users")
      .set("Authorization", await authHeader())
      .send({ externalIdpSubject, name: "Original User" });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/users")
      .set("Authorization", await authHeader())
      .send({ externalIdpSubject, name: "Duplicate Attempt" });

    expect(second.status).toBe(409);
    expect(second.body.title).toBe("USER_ALREADY_EXISTS");
    expect(second.body.detail).toContain(first.body.id);
  });
});

describe("GET /api/v1/users", () => {
  it("lists users for the authenticated tenant", async () => {
    const response = await request(app).get("/api/v1/users").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.data.every((u: { tenant_id: string }) => u.tenant_id === TEST_TENANT_ID)).toBe(true);
    // The seeded M2M test user itself must be present.
    expect(response.body.data.some((u: { id: string }) => u.id === TEST_USER_ID)).toBe(true);
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app).get("/api/v1/users");
    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/users/:id", () => {
  it("returns 404 for a user that does not exist", async () => {
    const response = await request(app)
      .get(`/api/v1/users/${randomUUID()}`)
      .set("Authorization", await authHeader());

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("USER_NOT_FOUND");
  });
});

describe("GET /api/v1/users/me", () => {
  it("returns the caller's own user record", async () => {
    const response = await request(app).get("/api/v1/users/me").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(TEST_USER_ID);
    expect(response.body.tenant_id).toBe(TEST_TENANT_ID);
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(app).get("/api/v1/users/me");
    expect(response.status).toBe(401);
  });

  it("is matched correctly and never confused with GET /users/:id", async () => {
    // A real regression risk: if route ordering were ever wrong, "me"
    // could be interpreted as a :id parameter instead of the literal
    // /me route, and this would 404 with USER_NOT_FOUND instead of
    // returning the caller's own record.
    const response = await request(app).get("/api/v1/users/me").set("Authorization", await authHeader());

    expect(response.status).not.toBe(404);
  });
});