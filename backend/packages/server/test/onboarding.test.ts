/**
 * Tests for the onboarding module.
 *
 * The HTTP-level happy path (a genuinely NEW identity onboarding
 * successfully) was proven manually with a real, fresh Auth0 M2M
 * application -- our test setup only has ONE reusable Auth0 identity
 * (the seeded TEST_TENANT_ID/TEST_USER_ID), which is already onboarded,
 * so it cannot exercise "onboard from nothing" over real HTTP without
 * creating a fresh Auth0 application per test run.
 *
 * Given that constraint: the service layer is tested directly here for the
 * full onboarding logic (atomic tenant+user creation, correct audit
 * attribution, period/chart-of-accounts seeding), and the HTTP layer is
 * tested for what our existing seeded identity CAN prove -- the
 * double-onboarding guard, and auth requirements.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { authHeader } from "./testAuth.js";
import { onboard } from "../src/modules/onboarding/service.js";

const app = createApp();

afterAll(async () => {
  await closePool();
});

describe("onboarding service (direct)", () => {
  it("creates a tenant and its first user atomically", async () => {
    const externalIdpSubject = `auth0|${randomUUID()}`;

    const result = await onboard({
      tenantName: "Test Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject,
      userName: "Test Owner",
      vatRegistered: false,
      periodStartDate: "2026-09-01",
    });

    expect(result.tenant.name).toBe("Test Kiosk");
    expect(result.tenant.status).toBe("ACTIVE");
    expect(result.user.tenant_id).toBe(result.tenant.id);
    expect(result.user.external_idp_subject).toBe(externalIdpSubject);
  });

  it("attributes both the tenant and user creation audit entries to the new user themselves", async () => {
    const externalIdpSubject = `auth0|${randomUUID()}`;

    const result = await onboard({
      tenantName: "Audit Test Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject,
      userName: "Audit Test Owner",
      vatRegistered: false,
      periodStartDate: "2026-09-01",
    });

    const auditRows = await withTenant(result.tenant.id, async (client) => {
      const rows = await client.query(
        `SELECT entity_type, entity_id, actor_user_id FROM audit_logs WHERE tenant_id = $1 ORDER BY occurred_at`,
        [result.tenant.id],
      );
      return rows.rows;
    });

    // tenant, user, then one per seeded account (period isn't audit-logged
    // by periods/repository.ts the same way, so it's not asserted here).
    expect(auditRows[0]!.entity_type).toBe("tenant");
    expect(auditRows[1]!.entity_type).toBe("user");
    // The new user is the actor of both -- correct, since nobody else
    // could possibly exist yet at the moment of onboarding.
    expect(auditRows[0]!.actor_user_id).toBe(result.user.id);
    expect(auditRows[1]!.actor_user_id).toBe(result.user.id);
  });

  it("rejects onboarding the same identity twice", async () => {
    const externalIdpSubject = `auth0|${randomUUID()}`;

    await onboard({
      tenantName: "First Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject,
      userName: "Owner",
      vatRegistered: false,
      periodStartDate: "2026-09-01",
    });

    await expect(
      onboard({
        tenantName: "Second Kiosk",
        tenantType: "BUSINESS",
        baseCurrency: "KES",
        externalIdpSubject,
        userName: "Owner Again",
        vatRegistered: false,
        periodStartDate: "2026-09-01",
      }),
    ).rejects.toThrow(/already onboarded/i);
  });

  it("stores vat_registered on the tenant as given", async () => {
    const result = await onboard({
      tenantName: "VAT Registered Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `auth0|${randomUUID()}`,
      userName: "Owner",
      vatRegistered: true,
      periodStartDate: "2026-09-01",
    });

    expect(result.tenant.vat_registered).toBe(true);
  });

  it("seeds one OPEN period from periodStartDate through the end of that month", async () => {
    const result = await onboard({
      tenantName: "Period Seed Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `auth0|${randomUUID()}`,
      userName: "Owner",
      vatRegistered: false,
      periodStartDate: "2026-09-15",
    });

    expect(result.period.start_date).toBe("2026-09-15");
    expect(result.period.end_date).toBe("2026-09-30");
    expect(result.period.status).toBe("OPEN");
  });

  it("seeds a non-VAT-registered tenant with a starter chart of accounts, excluding VAT accounts", async () => {
    const result = await onboard({
      tenantName: "Non-VAT Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `auth0|${randomUUID()}`,
      userName: "Owner",
      vatRegistered: false,
      periodStartDate: "2026-09-01",
    });

    const codes = result.accounts.map((a) => a.code).sort();
    expect(codes).toEqual(["1000", "1010", "1100", "2000", "3000", "4000", "5000", "5100"]);
    expect(result.accounts.every((a) => a.is_active)).toBe(true);
  });

  it("seeds a VAT-registered tenant with VAT Payable and VAT Recoverable accounts too", async () => {
    const result = await onboard({
      tenantName: "VAT Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `auth0|${randomUUID()}`,
      userName: "Owner",
      vatRegistered: true,
      periodStartDate: "2026-09-01",
    });

    const codes = result.accounts.map((a) => a.code).sort();
    expect(codes).toEqual(["1000", "1010", "1100", "1200", "2000", "2100", "3000", "4000", "5000", "5100"]);
  });

  it("can immediately record a credit sale using the seeded period and accounts, end to end", async () => {
    const result = await onboard({
      tenantName: "Immediate Use Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `auth0|${randomUUID()}`,
      userName: "Owner",
      vatRegistered: true,
      periodStartDate: "2026-09-01",
    });

    const arAccount = result.accounts.find((a) => a.code === "1100")!;
    const salesAccount = result.accounts.find((a) => a.code === "4000")!;
    const vatAccount = result.accounts.find((a) => a.code === "2100")!;

    // Posting a journal directly (rather than over HTTP) proves the seeded
    // period/accounts are real and usable, without needing a real Auth0
    // token for this brand-new tenant.
    const { createJournal } = await import("../src/modules/journals/service.js");
    const journal = await createJournal(
      {
        tenantId: result.tenant.id,
        clientUuid: randomUUID(),
        date: "2026-09-15",
        currency: "KES",
        description: "Credit sale",
        source: "SALE",
        lines: [
          { accountId: arAccount.id, debitMinor: 116000, creditMinor: 0 },
          { accountId: salesAccount.id, debitMinor: 0, creditMinor: 100000 },
          { accountId: vatAccount.id, debitMinor: 0, creditMinor: 16000 },
        ],
      },
      { actorUserId: result.user.id },
    );

    expect(journal.status).toBe("POSTED");
  });
});

describe("POST /api/v1/onboarding (HTTP)", () => {
  it("rejects a request with no Authorization header", async () => {
    const response = await request(app).post("/api/v1/onboarding").send({
      tenantName: "No Auth Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      userName: "Nobody",
      vatRegistered: false,
      periodStartDate: "2026-09-01",
    });

    expect(response.status).toBe(401);
  });

  it("rejects onboarding when the token's identity is already onboarded", async () => {
    // The seeded TEST_TENANT_ID/TEST_USER_ID identity is already onboarded
    // (it was seeded directly, which is functionally equivalent).
    const response = await request(app)
      .post("/api/v1/onboarding")
      .set("Authorization", await authHeader())
      .send({
        tenantName: "Already Onboarded Kiosk",
        tenantType: "BUSINESS",
        baseCurrency: "KES",
        userName: "Already Onboarded Owner",
        vatRegistered: false,
        periodStartDate: "2026-09-01",
      });

    expect(response.status).toBe(409);
    expect(response.body.title).toBe("USER_ALREADY_EXISTS");
  });

  it("rejects a malformed request body with a precise 400", async () => {
    const response = await request(app)
      .post("/api/v1/onboarding")
      .set("Authorization", await authHeader())
      .send({ tenantName: "Missing Fields Kiosk" });

    expect(response.status).toBe(400);
    expect(response.body.title).toBe("VALIDATION_ERROR");
  });
});
