/**
 * Role-based access control (FR-RBAC-01/02, FR-MIC-08).
 *
 * Three layers:
 *   1. Enforcement -- requirePermission against real users and roles in
 *      the database, via a small app with a stand-in identity step. The
 *      suite's one Auth0 token is always the test tenant's OWNER, so it
 *      can't exercise a restricted user through the real routers.
 *   2. Role management over HTTP -- /roles, /users/:id/roles, /users/me.
 *   3. Initial roles -- onboarding (OWNER), invites, direct provisioning.
 */

import { createHash, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@jibuks/domain";
import { createApp } from "../src/app.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { requirePermission } from "../src/middleware/requirePermission.js";
import { onboard } from "../src/modules/onboarding/service.js";
import * as invitesService from "../src/modules/invites/service.js";
import * as rolesService from "../src/modules/roles/service.js";
import { authHeader, TEST_TENANT_ID, TEST_USER_ID } from "./testAuth.js";

const app = createApp();

afterAll(async () => {
  await closePool();
});

/** Seeds a user in the test tenant with the given role refs, bypassing HTTP. */
async function seedUser(roleRefs: readonly string[]): Promise<string> {
  const userId = randomUUID();
  await withTenant(TEST_TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name) VALUES ($1, $2, $3, 'RBAC Test User')`,
      [userId, TEST_TENANT_ID, `test|${randomUUID()}`],
    );
    await rolesService.assignInitialRoles(client, TEST_TENANT_ID, userId, roleRefs, TEST_USER_ID);
  });
  return userId;
}

async function createCustomRole(permissions: readonly Permission[]): Promise<string> {
  const response = await request(app)
    .post("/api/v1/roles")
    .set("Authorization", await authHeader())
    .send({ name: `Role ${randomUUID().slice(0, 8)}`, permissions });
  expect(response.status).toBe(201);
  return response.body.id as string;
}

/** A one-route app: stand-in identity, then the real guard and error handler. */
function guardedApp(userId: string, permission: Permission) {
  const mini = express();
  mini.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = TEST_TENANT_ID;
    req.actorUserId = userId;
    next();
  });
  mini.post("/action", requirePermission(permission), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  mini.use(errorHandler);
  return mini;
}

describe("requirePermission enforcement", () => {
  it("lets a CASHIER record a cash sale but forbids posting a manual journal", async () => {
    const cashier = await seedUser(["CASHIER"]);

    const allowed = await request(guardedApp(cashier, "cash_sales:create")).post("/action");
    const denied = await request(guardedApp(cashier, "journals:create")).post("/action");

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(denied.body.title).toBe("FORBIDDEN");
    expect(denied.body.detail).toContain("journals:create");
  });

  it("forbids period reopen for everyone but OWNER and ACCOUNTANT", async () => {
    for (const key of Object.keys(SYSTEM_ROLES) as (keyof typeof SYSTEM_ROLES)[]) {
      const user = await seedUser([key]);
      const response = await request(guardedApp(user, "periods:reopen")).post("/action");
      expect(response.status, key).toBe(key === "OWNER" || key === "ACCOUNTANT" ? 200 : 403);
    }
  });

  it("lets a CASHIER see invoices and take payment against them, but not raise, issue or cancel one", async () => {
    const cashier = await seedUser(["CASHIER"]);
    const status = async (permission: Permission) => (await request(guardedApp(cashier, permission)).post("/action")).status;

    expect(await status("invoices:view")).toBe(200);
    expect(await status("payments:create")).toBe(200); // POST /invoices/{id}/payments
    expect(await status("invoices:create")).toBe(403);
    expect(await status("invoices:issue")).toBe(403);
    expect(await status("invoices:cancel")).toBe(403);
  });

  it("lets only OWNER and ACCOUNTANT override a credit limit", async () => {
    for (const key of Object.keys(SYSTEM_ROLES) as (keyof typeof SYSTEM_ROLES)[]) {
      const user = await seedUser([key]);
      const response = await request(guardedApp(user, "invoices:override_credit_limit")).post("/action");
      expect(response.status, key).toBe(key === "OWNER" || key === "ACCOUNTANT" ? 200 : 403);
    }
  });

  it("unions permissions across a user's roles", async () => {
    const custom = await createCustomRole(["reports:view"]);
    const user = await seedUser(["AGENT", custom]);

    expect((await request(guardedApp(user, "cash_sales:create")).post("/action")).status).toBe(200);
    expect((await request(guardedApp(user, "reports:view")).post("/action")).status).toBe(200);
    expect((await request(guardedApp(user, "bills:create")).post("/action")).status).toBe(403);
  });

  it("grants nothing through a deactivated custom role", async () => {
    const custom = await createCustomRole(["journals:create"]);
    const user = await seedUser([custom]);
    expect((await request(guardedApp(user, "journals:create")).post("/action")).status).toBe(200);

    await request(app).post(`/api/v1/roles/${custom}/deactivate`).set("Authorization", await authHeader());

    expect((await request(guardedApp(user, "journals:create")).post("/action")).status).toBe(403);
  });

  it("forbids a user with no roles at all", async () => {
    const user = await seedUser([]);
    expect((await request(guardedApp(user, "accounts:view")).post("/action")).status).toBe(403);
  });
});

describe("GET /api/v1/users/me", () => {
  it("returns the caller's roles and effective permissions", async () => {
    const response = await request(app).get("/api/v1/users/me").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(TEST_USER_ID);
    expect(response.body.roles.map((r: { id: string }) => r.id)).toContain("OWNER");
    expect(response.body.permissions).toEqual([...PERMISSIONS].sort());
  });
});

describe("/api/v1/roles", () => {
  it("lists the five built-in roles plus the permission catalogue", async () => {
    const roles = await request(app).get("/api/v1/roles").set("Authorization", await authHeader());
    const catalogue = await request(app).get("/api/v1/roles/permissions").set("Authorization", await authHeader());

    expect(roles.status).toBe(200);
    const builtIn = roles.body.data.filter((r: { system: boolean }) => r.system).map((r: { id: string }) => r.id);
    expect(builtIn).toEqual(["OWNER", "ACCOUNTANT", "CASHIER", "VIEWER", "AGENT"]);
    expect(catalogue.body.data).toEqual([...PERMISSIONS]);
  });

  it("creates, reads and updates a custom role", async () => {
    const name = `Stock Clerk ${randomUUID().slice(0, 8)}`;
    const created = await request(app)
      .post("/api/v1/roles")
      .set("Authorization", await authHeader())
      .send({ name, description: "Suppliers and bills", permissions: ["suppliers:view", "bills:create"] });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, system: false, isActive: true });

    const updated = await request(app)
      .patch(`/api/v1/roles/${created.body.id}`)
      .set("Authorization", await authHeader())
      .send({ permissions: ["suppliers:view", "suppliers:create", "bills:create"] });
    expect(updated.status).toBe(200);
    expect(updated.body.permissions).toEqual(["suppliers:view", "suppliers:create", "bills:create"]);
    expect(updated.body.name).toBe(name);

    const fetched = await request(app).get(`/api/v1/roles/${created.body.id}`).set("Authorization", await authHeader());
    expect(fetched.body.permissions).toHaveLength(3);
  });

  it("rejects an unknown permission with 400", async () => {
    const response = await request(app)
      .post("/api/v1/roles")
      .set("Authorization", await authHeader())
      .send({ name: `Bad ${randomUUID().slice(0, 8)}`, permissions: ["ledger:destroy"] });
    expect(response.status).toBe(400);
  });

  it("rejects a duplicate role name (case-insensitive) with 409", async () => {
    const name = `Dup ${randomUUID().slice(0, 8)}`;
    await request(app)
      .post("/api/v1/roles")
      .set("Authorization", await authHeader())
      .send({ name, permissions: ["reports:view"] });
    const second = await request(app)
      .post("/api/v1/roles")
      .set("Authorization", await authHeader())
      .send({ name: name.toUpperCase(), permissions: ["reports:view"] });
    expect(second.status).toBe(409);
  });

  it("refuses to change a built-in role with 422 ROLE_IMMUTABLE", async () => {
    const response = await request(app)
      .patch("/api/v1/roles/OWNER")
      .set("Authorization", await authHeader())
      .send({ name: "Boss" });
    expect(response.status).toBe(422);
    expect(response.body.title).toBe("ROLE_IMMUTABLE");
  });

  it("returns 404 ROLE_NOT_FOUND for an unknown or malformed id", async () => {
    const unknown = await request(app).get(`/api/v1/roles/${randomUUID()}`).set("Authorization", await authHeader());
    const malformed = await request(app).get("/api/v1/roles/not-a-role").set("Authorization", await authHeader());
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(malformed.body.title).toBe("ROLE_NOT_FOUND");
  });
});

describe("/api/v1/users/:id/roles", () => {
  it("defaults a directly provisioned user to VIEWER, or to the roles given", async () => {
    const defaulted = await request(app)
      .post("/api/v1/users")
      .set("Authorization", await authHeader())
      .send({ externalIdpSubject: `test|${randomUUID()}`, name: "Default Role" });
    const explicit = await request(app)
      .post("/api/v1/users")
      .set("Authorization", await authHeader())
      .send({ externalIdpSubject: `test|${randomUUID()}`, name: "Cashier", roles: ["CASHIER"] });

    const defaultedRoles = await request(app)
      .get(`/api/v1/users/${defaulted.body.id}/roles`)
      .set("Authorization", await authHeader());
    const explicitRoles = await request(app)
      .get(`/api/v1/users/${explicit.body.id}/roles`)
      .set("Authorization", await authHeader());

    expect(defaultedRoles.body.data.map((r: { id: string }) => r.id)).toEqual(["VIEWER"]);
    expect(explicitRoles.body.data.map((r: { id: string }) => r.id)).toEqual(["CASHIER"]);
  });

  it("replaces a user's roles", async () => {
    const user = await seedUser(["VIEWER"]);
    const custom = await createCustomRole(["bills:create"]);

    const response = await request(app)
      .put(`/api/v1/users/${user}/roles`)
      .set("Authorization", await authHeader())
      .send({ roles: ["CASHIER", custom] });

    expect(response.status).toBe(200);
    expect(response.body.data.map((r: { id: string }) => r.id)).toEqual(["CASHIER", custom]);
  });

  it("refuses a deactivated or unknown custom role with 404 ROLE_NOT_FOUND", async () => {
    const user = await seedUser(["VIEWER"]);
    const custom = await createCustomRole(["bills:create"]);
    await request(app).post(`/api/v1/roles/${custom}/deactivate`).set("Authorization", await authHeader());

    const deactivated = await request(app)
      .put(`/api/v1/users/${user}/roles`)
      .set("Authorization", await authHeader())
      .send({ roles: [custom] });
    const unknown = await request(app)
      .put(`/api/v1/users/${user}/roles`)
      .set("Authorization", await authHeader())
      .send({ roles: [randomUUID()] });

    expect(deactivated.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(unknown.body.title).toBe("ROLE_NOT_FOUND");
  });

  it("refuses to remove the last active OWNER with 422 LAST_OWNER, leaving roles unchanged", async () => {
    // Other tests may have added owners to the shared test tenant; demote
    // them in-transaction so the test user is provably the only one.
    await withTenant(TEST_TENANT_ID, async (client) => {
      await client.query(
        `UPDATE user_roles SET system_role = 'VIEWER' WHERE system_role = 'OWNER' AND user_id <> $1`,
        [TEST_USER_ID],
      );
    });

    const response = await request(app)
      .put(`/api/v1/users/${TEST_USER_ID}/roles`)
      .set("Authorization", await authHeader())
      .send({ roles: ["ACCOUNTANT"] });
    const me = await request(app).get("/api/v1/users/me").set("Authorization", await authHeader());

    expect(response.status).toBe(422);
    expect(response.body.title).toBe("LAST_OWNER");
    expect(me.body.roles.map((r: { id: string }) => r.id)).toEqual(["OWNER"]);
  });
});

describe("initial roles", () => {
  it("makes the onboarding user the new tenant's OWNER", async () => {
    const result = await onboard({
      tenantName: "RBAC Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `test|${randomUUID()}`,
      userName: "Founder",
      vatRegistered: false,
      periodStartDate: "2026-09-01",
    });

    const roles = await rolesService.getUserRoles(result.tenant.id, result.user.id);
    expect(roles.map((r) => r.id)).toEqual(["OWNER"]);
  });

  it("gives an invitee the role named on the invite", async () => {
    const token = randomUUID();
    await withTenant(TEST_TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO invites (tenant_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'CASHIER', $3, $4, now() + interval '1 day')`,
        [TEST_TENANT_ID, `cashier-${randomUUID()}@example.com`, createHash("sha256").update(token).digest("hex"), TEST_USER_ID],
      );
    });

    const accepted = await invitesService.acceptInvite(token, `test|${randomUUID()}`, "New Cashier");

    const roles = await rolesService.getUserRoles(TEST_TENANT_ID, accepted.userId);
    expect(roles.map((r) => r.id)).toEqual(["CASHIER"]);
  });

  it("rejects an invite naming an unknown role with 404 ROLE_NOT_FOUND", async () => {
    const response = await request(app)
      .post("/api/v1/invites")
      .set("Authorization", await authHeader())
      .send({ email: `nobody-${randomUUID()}@example.com`, role: randomUUID() });
    expect(response.status).toBe(404);
    expect(response.body.title).toBe("ROLE_NOT_FOUND");
  });
});
