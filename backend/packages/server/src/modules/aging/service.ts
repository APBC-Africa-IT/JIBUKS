/**
 * Aging (FR-AR-04, FR-AP-03): what each customer owes us, or we owe each
 * supplier, by how long it is past due -- current, 1-30, 31-60, 61-90 and
 * over 90 days.
 *
 * Built from invoices (receivables) or bills (payables), since only those
 * have due dates. Anything else on a party's ledger balance -- credit sales
 * or guided POST /bills without a record, money received beyond an invoice,
 * manual journals -- can't be aged, so it is shown as not_invoiced_minor /
 * not_billed_minor. That keeps every row's balance_minor equal to the
 * party's ledger balance at the as-of date (the same figure GET /customers
 * or GET /suppliers returns).
 */

import { AGING_BUCKETS, agingBucket, daysPastDue, type AgingBucket } from "@jibuks/domain";
import * as customersService from "../customers/service.js";
import * as suppliersService from "../suppliers/service.js";
import * as documents from "../invoices/documents.js";
import { AP, AR, type Side } from "../invoices/documents.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";

type BucketAmounts = Record<AgingBucket, number>;

/** Response field names for each side. */
interface Names {
  readonly partyId: string;
  readonly partyName: string;
  readonly documented: string;
  readonly undocumented: string;
  readonly documents: string;
}

const NAMES: Readonly<Record<"AR" | "AP", Names>> = {
  AR: {
    partyId: "customer_id",
    partyName: "customer_name",
    documented: "invoiced_minor",
    undocumented: "not_invoiced_minor",
    documents: "invoices",
  },
  AP: {
    partyId: "supplier_id",
    partyName: "supplier_name",
    documented: "billed_minor",
    undocumented: "not_billed_minor",
    documents: "bills",
  },
};

interface Party {
  readonly id: string;
  readonly name: string;
  readonly balance_minor: string;
}

function listParties(side: Side, tenantId: string, asOf: string): Promise<Party[]> {
  return side.direction === "AR" ? customersService.listCustomers(tenantId, asOf) : suppliersService.listSuppliers(tenantId, asOf);
}

function getParty(side: Side, tenantId: string, partyId: string, asOf: string): Promise<Party> {
  return side.direction === "AR"
    ? customersService.getCustomer(tenantId, partyId, asOf)
    : suppliersService.getSupplier(tenantId, partyId, asOf);
}

function emptyBuckets(): BucketAmounts {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as BucketAmounts;
}

/** Bucket keys as response fields: CURRENT -> current_minor, DAYS_1_30 -> days_1_30_minor. */
function bucketFields(buckets: BucketAmounts): Record<string, string> {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [`${b.toLowerCase()}_minor`, String(buckets[b])]));
}

function ageOf(row: { due_date: string | null; issue_date: string }, asOf: string): number {
  return daysPastDue(row.due_date ?? row.issue_date, asOf);
}

/** One row per party: ids and names, one `<bucket>_minor` per bucket, documented, undocumented and balance. */
export type AgingRow = Readonly<Record<string, string>>;

export interface AgingReport {
  readonly as_of: string;
  readonly currency: string;
  readonly buckets: readonly AgingBucket[];
  readonly rows: AgingRow[];
  readonly totals: Record<string, string>;
}

async function getAging(side: Side, tenantId: string, asOf?: string): Promise<AgingReport> {
  const names = NAMES[side.direction];
  const date = asOf ?? todayInNairobi();
  const [tenant, parties, open] = await Promise.all([
    tenantsService.getTenant(tenantId),
    listParties(side, tenantId, date),
    documents.listOpenAsOf(side, tenantId, date),
  ]);

  const byParty = new Map<string, BucketAmounts>();
  for (const doc of open) {
    const buckets = byParty.get(doc.party_id) ?? emptyBuckets();
    buckets[agingBucket(ageOf(doc, date))] += Number(doc.open_minor);
    byParty.set(doc.party_id, buckets);
  }

  const totals = { buckets: emptyBuckets(), documented: 0, undocumented: 0, balance: 0 };
  const rows: AgingRow[] = [];
  for (const party of parties) {
    const buckets = byParty.get(party.id) ?? emptyBuckets();
    const documented = AGING_BUCKETS.reduce((sum, b) => sum + buckets[b], 0);
    const balance = Number(party.balance_minor);
    if (documented === 0 && balance === 0) {
      continue;
    }
    for (const b of AGING_BUCKETS) {
      totals.buckets[b] += buckets[b];
    }
    totals.documented += documented;
    totals.undocumented += balance - documented;
    totals.balance += balance;
    rows.push({
      [names.partyId]: party.id,
      [names.partyName]: party.name,
      ...bucketFields(buckets),
      [names.documented]: String(documented),
      [names.undocumented]: String(balance - documented),
      balance_minor: String(balance),
    });
  }
  rows.sort(
    (a, b) =>
      Number(b["balance_minor"]) - Number(a["balance_minor"]) || a[names.partyName]!.localeCompare(b[names.partyName]!),
  );

  return {
    as_of: date,
    currency: tenant.base_currency,
    buckets: AGING_BUCKETS,
    rows,
    totals: {
      ...bucketFields(totals.buckets),
      [names.documented]: String(totals.documented),
      [names.undocumented]: String(totals.undocumented),
      balance_minor: String(totals.balance),
    },
  };
}

/** Drill-down: one party's open invoices or bills at the as-of date (FR-RPT-03). */
async function getPartyAging(side: Side, tenantId: string, partyId: string, asOf?: string): Promise<Record<string, unknown>> {
  const names = NAMES[side.direction];
  const date = asOf ?? todayInNairobi();
  const party = await getParty(side, tenantId, partyId, date);
  const [tenant, open] = await Promise.all([
    tenantsService.getTenant(tenantId),
    documents.listOpenAsOf(side, tenantId, date, partyId),
  ]);
  const documented = open.reduce((sum, d) => sum + Number(d.open_minor), 0);
  const balance = Number(party.balance_minor);
  return {
    as_of: date,
    currency: tenant.base_currency,
    [names.partyId]: party.id,
    [names.partyName]: party.name,
    [names.documents]: open.map((doc) => {
      const days = ageOf(doc, date);
      return {
        id: doc.id,
        number: doc.number,
        [side.direction === "AR" ? "issue_date" : "bill_date"]: doc.issue_date,
        due_date: doc.due_date,
        days_past_due: Math.max(days, 0),
        bucket: agingBucket(days),
        total_minor: doc.total_minor,
        open_minor: doc.open_minor,
      };
    }),
    [names.documented]: String(documented),
    [names.undocumented]: String(balance - documented),
    balance_minor: String(balance),
  };
}

export const getReceivablesAging = (tenantId: string, asOf?: string) => getAging(AR, tenantId, asOf);
export const getCustomerAging = (tenantId: string, customerId: string, asOf?: string) =>
  getPartyAging(AR, tenantId, customerId, asOf);
export const getPayablesAging = (tenantId: string, asOf?: string) => getAging(AP, tenantId, asOf);
export const getSupplierAging = (tenantId: string, supplierId: string, asOf?: string) =>
  getPartyAging(AP, tenantId, supplierId, asOf);
