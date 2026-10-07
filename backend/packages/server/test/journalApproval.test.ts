/**
 * Manual journal approval (FR-JNL-01) with segregation of duties
 * (FR-RBAC-03). Approval is a business-wide setting and needs two people,
 * so each test onboards its own business (Owner) and adds an Accountant,
 * calling the services as each of them; HTTP is checked on the shared
 * tenant for routing and validation only.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenant } from "@jibuks/db";
import { createApp } from "../src/app.js";
import { listen } from "./testServer.js";
import { authHeader } from "./testAuth.js";
import { onboard } from "../src/modules/onboarding/service.js";
import * as journalsService from "../src/modules/journals/service.js";
import * as accountsService from "../src/modules/accounts/service.js";
import * as periodsService from "../src/modules/periods/service.js";
import * as rolesService from "../src/modules/roles/service.js";
import * as tenantsService from "../src/modules/tenants/service.js";

const app = await listen(createApp());

afterAll(async () => {
  await closePool();
});

async function addUser(tenantId: string, ownerId: string, role: string): Promise<string> {
  const userId = randomUUID();
  await withTenant(tenantId, async (client) => {
    await client.query(`INSERT INTO users (id, tenant_id, external_idp_subject, name) VALUES ($1, $2, $3, $4)`, [
      userId,
      tenantId,
      `test|${randomUUID()}`,
      `${role} user`,
    ]);
    await rolesService.assignInitialRoles(client, tenantId, userId, [role], ownerId);
  });
  return userId;
}

async function business(threshold: number | null = 1_000_000) {
  const { tenant, user, accounts, period } = await onboard({
    tenantName: "Approval Co",
    tenantType: "BUSINESS",
    baseCurrency: "KES",
    externalIdpSubject: `test|${randomUUID()}`,
    userName: "Owner",
    vatRegistered: false,
    periodStartDate: "2026-09-01",
  });
  const owner = { actorUserId: user.id };
  const accountant = { actorUserId: await addUser(tenant.id, user.id, "ACCOUNTANT") };
  if (threshold !== null) {
    await tenantsService.updateTenant(tenant.id, { manualJournalApprovalThresholdMinor: threshold }, owner);
  }
  const code = (c: string) => accounts.find((a) => a.code === c)!.id;
  return { tenantId: tenant.id, owner, accountant, period, cash: code("1000"), bank: code("1010") };
}

type Business = Awaited<ReturnType<typeof business>>;

function transfer(b: Business, amountMinor: number) {
  return journalsService.createManualJournal(
    {
      tenantId: b.tenantId,
      clientUuid: randomUUID(),
      date: "2026-09-10",
      currency: "KES",
      description: "Cash banked",
      source: "MANUAL",
      lines: [
        { accountId: b.bank, debitMinor: amountMinor, creditMinor: 0 },
        { accountId: b.cash, debitMinor: 0, creditMinor: amountMinor },
      ],
    },
    b.owner,
  );
}

const balance = async (b: Business, accountId: string) => (await accountsService.getAccount(b.tenantId, accountId)).balance_minor;

describe("turning approval on", () => {
  it("needs two active users who can approve", async () => {
    const { tenant, user } = await onboard({
      tenantName: "Solo Shop",
      tenantType: "BUSINESS",
      baseCurrency: "KES",
      externalIdpSubject: `test|${randomUUID()}`,
      userName: "Owner",
      vatRegistered: false,
      periodStartDate: "2026-09-01",
    });
    const owner = { actorUserId: user.id };

    const alone = tenantsService.updateTenant(tenant.id, { manualJournalApprovalThresholdMinor: 0 }, owner);
    await expect(alone).rejects.toMatchObject({ code: "NOT_ENOUGH_APPROVERS" });

    await addUser(tenant.id, user.id, "CASHIER"); // can't approve: still one approver
    await expect(
      tenantsService.updateTenant(tenant.id, { manualJournalApprovalThresholdMinor: 0 }, owner),
    ).rejects.toMatchObject({ code: "NOT_ENOUGH_APPROVERS" });

    await addUser(tenant.id, user.id, "ACCOUNTANT");
    const on = await tenantsService.updateTenant(tenant.id, { manualJournalApprovalThresholdMinor: 0 }, owner);
    const off = await tenantsService.updateTenant(tenant.id, { manualJournalApprovalThresholdMinor: null }, owner);

    expect(on.manual_journal_approval_threshold_minor).toBe("0");
    expect(off.manual_journal_approval_threshold_minor).toBeNull();
  });
});

describe("manual journals under approval", () => {
  it("posts below the threshold and holds at or above it, without touching balances", async () => {
    const b = await business(1_000_000);

    const small = await transfer(b, 999_999);
    const large = await transfer(b, 1_000_000);

    expect(small.status).toBe("POSTED");
    expect(large.status).toBe("PENDING_APPROVAL");
    expect(await balance(b, b.bank)).toBe("999999");
    const pending = await journalsService.listJournals(b.tenantId, "PENDING_APPROVAL");
    expect(pending.map((j) => j.id)).toEqual([large.id]);
  });

  it("holds every manual journal at threshold 0, and none when approval is off", async () => {
    const all = await business(0);
    const off = await business(null);

    expect((await transfer(all, 1)).status).toBe("PENDING_APPROVAL");
    expect((await transfer(off, 50_000_000)).status).toBe("POSTED");
  });

  it("can't be approved by whoever entered it; a second person posts it", async () => {
    const b = await business(0);
    const journal = await transfer(b, 250_000);

    const self = journalsService.approveJournal(b.tenantId, journal.id, b.owner);
    await expect(self).rejects.toMatchObject({ code: "SELF_APPROVAL_FORBIDDEN" });

    const approved = await journalsService.approveJournal(b.tenantId, journal.id, b.accountant);
    expect(approved).toMatchObject({ status: "POSTED", approved_by: b.accountant.actorUserId, created_by: b.owner.actorUserId });
    expect(approved.approved_at).toBeTruthy();
    expect(await balance(b, b.bank)).toBe("250000");

    const again = journalsService.approveJournal(b.tenantId, journal.id, b.accountant);
    await expect(again).rejects.toMatchObject({ code: "JOURNAL_NOT_PENDING" });
  });

  it("rejection is final, keeps the reason, and posts nothing", async () => {
    const b = await business(0);
    const journal = await transfer(b, 300_000);

    const rejected = await journalsService.rejectJournal(b.tenantId, journal.id, "Wrong bank account", b.accountant);

    expect(rejected).toMatchObject({
      status: "REJECTED",
      rejected_by: b.accountant.actorUserId,
      rejection_reason: "Wrong bank account",
    });
    expect(await balance(b, b.bank)).toBe("0");
    await expect(journalsService.approveJournal(b.tenantId, journal.id, b.accountant)).rejects.toMatchObject({
      code: "JOURNAL_NOT_PENDING",
    });
    await expect(journalsService.reverseJournal(b.tenantId, journal.id, "x", b.accountant)).rejects.toMatchObject({
      code: "JOURNAL_IMMUTABLE",
    });
  });

  it("re-checks the period at approval: a journal in a period closed meanwhile stays pending", async () => {
    const b = await business(0);
    const journal = await transfer(b, 100_000);
    await periodsService.closePeriod(b.tenantId, b.period.id, b.owner);

    const attempt = journalsService.approveJournal(b.tenantId, journal.id, b.accountant);

    await expect(attempt).rejects.toMatchObject({ code: "PERIOD_LOCKED" });
    expect((await journalsService.getJournal(b.tenantId, journal.id)).status).toBe("PENDING_APPROVAL");
  });

  it("a pending journal can't be reversed", async () => {
    const b = await business(0);
    const journal = await transfer(b, 100_000);

    await expect(journalsService.reverseJournal(b.tenantId, journal.id, "x", b.accountant)).rejects.toMatchObject({
      code: "JOURNAL_IMMUTABLE",
    });
  });
});

describe("journal approval over HTTP", () => {
  it("lists by status, refuses to approve a posted journal, and validates a rejection", async () => {
    const auth = { Authorization: await authHeader() };
    const posted = await request(app).get("/api/v1/journals?status=POSTED").set(auth);
    const pending = await request(app).get("/api/v1/journals?status=PENDING_APPROVAL").set(auth);
    const badStatus = await request(app).get("/api/v1/journals?status=WHATEVER").set(auth);

    expect(pending.status).toBe(200);
    expect(badStatus.status).toBe(400);
    const anyPosted = posted.body.data[0];
    if (anyPosted) {
      const approve = await request(app).post(`/api/v1/journals/${anyPosted.id}/approve`).set(auth);
      const reject = await request(app).post(`/api/v1/journals/${anyPosted.id}/reject`).set(auth).send({});
      expect(approve.status).toBe(422);
      expect(approve.body.title).toBe("JOURNAL_NOT_PENDING");
      expect(reject.status).toBe(400);
    }
  });
});
