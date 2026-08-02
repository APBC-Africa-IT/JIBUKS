/**
 * HTTP-level tests for the users module.
 *
 * The "rejects a duplicate externalIdpSubject with USER_ALREADY_EXISTS"
 * test specifically guards against a real bug found and fixed: the
 * duplicate check originally ran via withoutTenant, which RLS silently
 * defeated (no tenant context set means the policy matches nothing), so
 * the check always saw zero rows and the request fell through to
 * Postgres's own unique constraint, surfacing as a generic DUPLICATE_VALUE
 * instead of the precise USER_ALREADY_EXISTS. The fix was a dedicated
 * BYPASSRLS role (jibuks_auth_resolver) for this one legitimate
 * cross-tenant lookup. This test exists so that regression is impossible
 * to reintroduce silently.
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

async function makeTenant(): Promise<string> {
  const tenantId = randomUUID();
  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [tenantId, `Tenant ${tenantId}`],
    );
  });
  return tenantId;
}

describe("POST /api/v1/users", () => {
  it("creates a user, recorded as the actor of their own creation", async () => {
    const tenantId = await makeTenant();
    const externalIdpSubject = `auth0|${randomUUID()}`;

    const response = await request(app)
      .post("/api/v1/users")
      .set("X-Tenant-Id", tenantId)
      .send({ externalIdpSubject, name: "Test User", email: "test@example.com" });

    expect(response.status).toBe(201);
    expect(response.body.external_idp_subject).toBe(externalIdpSubject);
    expect(response.body.status).toBe("ACTIVE");
    expect(response.body.is_super_admin).toBe(false);

    const auditRows = await withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT actor_user_id, entity_id FROM audit_logs WHERE entity_id = $1`,
        [response.body.id],
      );
      return result.rows;
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.actor_user_id).toBe(response.body.id);
  });

  it("rejects a duplicate externalIdpSubject with a precise 409 USER_ALREADY_EXISTS, not a generic DUPLICATE_VALUE", async () => {
    const tenantId = await makeTenant();
    const externalIdpSubject = `auth0|${randomUUID()}`;

    const first = await request(app)
      .post("/api/v1/users")
      .set("X-Tenant-Id", tenantId)
      .send({ externalIdpSubject, name: "Original User" });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/users")
      .set("X-Tenant-Id", tenantId)
      .send({ externalIdpSubject, name: "Duplicate Attempt" });

    expect(second.status).toBe(409);
    expect(second.body.title).toBe("USER_ALREADY_EXISTS");
    expect(second.body.detail).toContain(first.body.id);
  });

  it("rejects a duplicate externalIdpSubject even across DIFFERENT tenants", async () => {
    // external_idp_subject is globally unique (one identity provider
    // subject identifies exactly one person across the whole platform),
    // not scoped per tenant like account codes are.
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const externalIdpSubject = `auth0|${randomUUID()}`;

    const first = await request(app)
      .post("/api/v1/users")
      .set("X-Tenant-Id", tenantA)
      .send({ externalIdpSubject, name: "User In Tenant A" });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/users")
      .set("X-Tenant-Id", tenantB)
      .send({ externalIdpSubject, name: "Same Identity, Different Tenant" });

    expect(second.status).toBe(409);
    expect(second.body.title).toBe("USER_ALREADY_EXISTS");
  });
});

describe("GET /api/v1/users", () => {
  it("lists only users belonging to the requesting tenant", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();

    await request(app)
      .post("/api/v1/users")
      .set("X-Tenant-Id", tenantA)
      .send({ externalIdpSubject: `auth0|${randomUUID()}`, name: "User A" });

    await request(app)
      .post("/api/v1/users")
      .set("X-Tenant-Id", tenantB)
      .send({ externalIdpSubject: `auth0|${randomUUID()}`, name: "User B" });

    const response = await request(app).get("/api/v1/users").set("X-Tenant-Id", tenantA);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].name).toBe("User A");
  });
});

describe("GET /api/v1/users/:id", () => {
  it("returns 404 for a user that does not exist", async () => {
    const tenantId = await makeTenant();

    const response = await request(app).get(`/api/v1/users/${randomUUID()}`).set("X-Tenant-Id", tenantId);

    expect(response.status).toBe(404);
    expect(response.body.title).toBe("USER_NOT_FOUND");
  });

  it("returns 404 for a real user ID that belongs to a different tenant", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();

    const created = await request(app)
      .post("/api/v1/users")
      .set("X-Tenant-Id", tenantA)
      .send({ externalIdpSubject: `auth0|${randomUUID()}`, name: "User A" });

    const response = await request(app).get(`/api/v1/users/${created.body.id}`).set("X-Tenant-Id", tenantB);

    expect(response.status).toBe(404);
  });
});