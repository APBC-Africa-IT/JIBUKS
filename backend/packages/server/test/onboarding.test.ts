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
import { listen } from "./testServer.js";
import { authHeader } from "./testAuth.js";
import { onboard } from "../src/modules/onboarding/service.js";

const app = await listen(createApp());

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
    expect(codes).toEqual(["1000", "1010", "1020", "1100", "2000", "3000", "3900", "4000", "5000", "5100"]);
    expect(result.accounts.every((a) => a.is_active)).toBe(true);
    // The M-Pesa account is found by system key, not by its code.
    expect(result.accounts.filter((a) => a.system_key === "MPESA").map((a) => a.code)).toEqual(["1020"]);
    expect(result.accounts.filter((a) => a.system_key === "OPENING_BALANCE").map((a) => a.code)).toEqual(["3900"]);
    expect(result.tenant.chart_template).toBe("GENERAL");
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
    expect(codes).toEqual(["1000", "1010", "1020", "1100", "1200", "2000", "2100", "3000", "3900", "4000", "5000", "5100"]);
  });

  it.each([
    { template: "SME_TRADING", vat: false, count: 26, mpesa: "1020" },
    { template: "SME_TRADING", vat: true, count: 27, mpesa: "1020" },
    { template: "NGO", vat: false, count: 17, mpesa: null },
    { template: "NGO", vat: true, count: 19, mpesa: null },
    { template: "CORPORATE", vat: true, count: 22, mpesa: null },
    { template: "MICRO_TRADER", vat: false, count: 12, mpesa: "1020" },
  ] as const)("seeds the $template template (VAT $vat)", async ({ template, vat, count, mpesa }) => {
    const result = await onboard({
      tenantName: `${template} Co`,
      tenantType: template === "NGO" ? "NGO" : "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `auth0|${randomUUID()}`,
      userName: "Owner",
      vatRegistered: vat,
      periodStartDate: "2026-09-01",
      chartTemplate: template,
    });

    expect(result.tenant.chart_template).toBe(template);
    expect(result.accounts).toHaveLength(count);
    const byKey = (key: string) => result.accounts.filter((a) => a.system_key === key).map((a) => a.code);
    expect(byKey("OPENING_BALANCE")).toEqual(["3900"]);
    expect(byKey("MPESA")).toEqual(mpesa ? [mpesa] : []);
    // Every template's codes are unique and its types are valid (the database would refuse otherwise).
    expect(new Set(result.accounts.map((a) => a.code)).size).toBe(count);
  });

  it("gives micro-traders plain-language names and an account for money owed to them", async () => {
    const result = await onboard({
      tenantName: "Mama Njeri Kiosk",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `auth0|${randomUUID()}`,
      userName: "Njeri",
      vatRegistered: false,
      periodStartDate: "2026-09-01",
      chartTemplate: "MICRO_TRADER",
    });

    const names = Object.fromEntries(result.accounts.map((a) => [a.code, a.name]));
    expect(names).toMatchObject({ "1030": "Money Owed to Me", "2000": "Money I Owe", "3000": "My Money in the Business" });
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

describe("GET /api/v1/onboarding/chart-templates", () => {
  it("lists the five templates with their accounts, before sign-up", async () => {
    const response = await request(app).get("/api/v1/onboarding/chart-templates").set("Authorization", await authHeader());

    expect(response.status).toBe(200);
    expect(response.body.data.map((t: { key: string }) => t.key)).toEqual([
      "GENERAL",
      "SME_TRADING",
      "NGO",
      "CORPORATE",
      "MICRO_TRADER",
    ]);
    expect(response.body.data[4].accounts).toContainEqual({ code: "1020", name: "M-Pesa / Airtel", type: "ASSET", systemKey: "MPESA" });
  });

  it("requires a token", async () => {
    const response = await request(app).get("/api/v1/onboarding/chart-templates");
    expect(response.status).toBe(401);
  });
});
