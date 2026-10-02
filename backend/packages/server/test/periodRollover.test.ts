/**
 * Automatic opening of the current month's period before a posting
 * (periods.ensureCurrentPeriodForDate), so Cashier and Agent -- who can't
 * manage periods -- aren't blocked at every month boundary.
 *
 * Each test seeds its own tenant: the shared TEST_TENANT_ID already has
 * periods covering most dates, which would hide the behaviour under test.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant, withTenant } from "@jibuks/db";
import * as periodsService from "../src/modules/periods/service.js";
import * as accountsService from "../src/modules/accounts/service.js";
import * as journalsService from "../src/modules/journals/service.js";

afterAll(async () => {
  await closePool();
});

async function seedTenant(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [tenantId, `Rollover Tenant ${tenantId}`],
    );
  });
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name) VALUES ($1, $2, $3, 'Rollover User')`,
      [userId, tenantId, `test|${userId}`],
    );
  });
  return { tenantId, userId };
}

async function insertPeriod(tenantId: string, startDate: string, endDate: string, status = "OPEN"): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(`INSERT INTO periods (tenant_id, start_date, end_date, status) VALUES ($1, $2, $3, $4)`, [
      tenantId,
      startDate,
      endDate,
      status,
    ]);
  });
}

function spans(periods: readonly { start_date: string; end_date: string }[]): string[] {
  return periods.map((p) => `${p.start_date}..${p.end_date}`);
}

describe("ensureCurrentPeriodForDate", () => {
  it("opens the whole current month when no period covers the date, once", async () => {
    const { tenantId, userId } = await seedTenant();

    await periodsService.ensureCurrentPeriodForDate(tenantId, "2031-02-14", { actorUserId: userId }, "2031-02-20");
    await periodsService.ensureCurrentPeriodForDate(tenantId, "2031-02-27", { actorUserId: userId }, "2031-02-20");

    const periods = await periodsService.listPeriods(tenantId);
    expect(spans(periods)).toEqual(["2031-02-01..2031-02-28"]);
    expect(periods[0]!.status).toBe("OPEN");
  });

  it("never opens a month other than the current one", async () => {
    const { tenantId, userId } = await seedTenant();

    await periodsService.ensureCurrentPeriodForDate(tenantId, "2031-01-31", { actorUserId: userId }, "2031-02-01");
    await periodsService.ensureCurrentPeriodForDate(tenantId, "2031-03-01", { actorUserId: userId }, "2031-02-28");

    expect(await periodsService.listPeriods(tenantId)).toEqual([]);
  });

  it("leaves a closed period alone, so the posting still fails as PERIOD_LOCKED", async () => {
    const { tenantId, userId } = await seedTenant();
    await insertPeriod(tenantId, "2031-02-01", "2031-02-28", "CLOSED");

    await periodsService.ensureCurrentPeriodForDate(tenantId, "2031-02-14", { actorUserId: userId }, "2031-02-14");

    const periods = await periodsService.listPeriods(tenantId);
    expect(spans(periods)).toEqual(["2031-02-01..2031-02-28"]);
    expect(periods[0]!.status).toBe("CLOSED");
  });

  it("fills only the gap between existing periods within the month", async () => {
    const { tenantId, userId } = await seedTenant();
    await insertPeriod(tenantId, "2031-01-15", "2031-02-10", "CLOSED");
    await insertPeriod(tenantId, "2031-02-21", "2031-03-31");

    await periodsService.ensureCurrentPeriodForDate(tenantId, "2031-02-15", { actorUserId: userId }, "2031-02-15");

    const periods = await periodsService.listPeriods(tenantId);
    expect(spans(periods)).toContain("2031-02-11..2031-02-20");
    expect(periods).toHaveLength(3);
  });

  it("creates exactly one period when postings race on the first of the month", async () => {
    const { tenantId, userId } = await seedTenant();

    await Promise.all(
      Array.from({ length: 5 }, () =>
        periodsService.ensureCurrentPeriodForDate(tenantId, "2031-04-01", { actorUserId: userId }, "2031-04-01"),
      ),
    );

    expect(spans(await periodsService.listPeriods(tenantId))).toEqual(["2031-04-01..2031-04-30"]);
  });
});

describe("posting with no period for the current month", () => {
  it("opens the month and posts, instead of failing with PERIOD_NOT_FOUND", async () => {
    const { tenantId, userId } = await seedTenant();
    const audit = { actorUserId: userId };
    const cash = await accountsService.createAccount({ tenantId, code: "1000", name: "Cash", type: "ASSET" }, audit);
    const sales = await accountsService.createAccount({ tenantId, code: "4000", name: "Sales", type: "INCOME" }, audit);
    const today = periodsService.todayInNairobi();

    const journal = await journalsService.createJournal(
      {
        tenantId,
        clientUuid: randomUUID(),
        date: today,
        currency: "KES",
        description: "Cash sale on the first day of a new month",
        source: "MANUAL",
        lines: [
          { accountId: cash.id, debitMinor: 1000, creditMinor: 0 },
          { accountId: sales.id, debitMinor: 0, creditMinor: 1000 },
        ],
      },
      audit,
    );

    const periods = await periodsService.listPeriods(tenantId);
    expect(periods).toHaveLength(1);
    expect(journal.period_id).toBe(periods[0]!.id);
    expect(periods[0]!.start_date).toBe(`${today.slice(0, 7)}-01`);
  });
});
