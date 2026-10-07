/**
 * Customer aging (FR-AR-04): what each customer owes, by how long it is
 * past due -- current, 1-30, 31-60, 61-90 and over 90 days.
 *
 * Built from invoices, since only an invoice has a due date. Anything else
 * on a customer's ledger balance -- credit sales recorded without an
 * invoice, M-Pesa money received beyond an invoice (customer credit),
 * manual journals -- can't be aged, so it is shown as `not_invoiced_minor`.
 * That keeps every row's balance_minor equal to the customer's ledger
 * balance at the as-of date (the same figure GET /customers returns).
 */

import { AGING_BUCKETS, agingBucket, daysPastDue, type AgingBucket } from "@jibuks/domain";
import * as customersService from "../customers/service.js";
import * as invoicesService from "../invoices/service.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";

type BucketAmounts = Record<AgingBucket, number>;

function emptyBuckets(): BucketAmounts {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as BucketAmounts;
}

/** Bucket keys as response fields: CURRENT -> current_minor, DAYS_1_30 -> days_1_30_minor. */
function bucketFields(buckets: BucketAmounts): Record<string, string> {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [`${b.toLowerCase()}_minor`, String(buckets[b])]));
}

/** customer_id, customer_name, one `<bucket>_minor` per bucket, invoiced_minor, not_invoiced_minor, balance_minor. */
export type AgingRow = Readonly<Record<string, string>>;

export interface ReceivablesAging {
  readonly as_of: string;
  readonly currency: string;
  readonly buckets: readonly AgingBucket[];
  readonly rows: AgingRow[];
  readonly totals: Record<string, string>;
}

export interface CustomerAgingDetail {
  readonly as_of: string;
  readonly currency: string;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly invoices: Array<{
    readonly id: string;
    readonly number: string;
    readonly issue_date: string;
    readonly due_date: string | null;
    readonly days_past_due: number;
    readonly bucket: AgingBucket;
    readonly total_minor: string;
    readonly open_minor: string;
  }>;
  readonly invoiced_minor: string;
  readonly not_invoiced_minor: string;
  readonly balance_minor: string;
}

function ageOf(row: { due_date: string | null; issue_date: string }, asOf: string): number {
  return daysPastDue(row.due_date ?? row.issue_date, asOf);
}

export async function getReceivablesAging(tenantId: string, asOf?: string): Promise<ReceivablesAging> {
  const date = asOf ?? todayInNairobi();
  const [tenant, customers, open] = await Promise.all([
    tenantsService.getTenant(tenantId),
    customersService.listCustomers(tenantId, date),
    invoicesService.listOpenInvoicesAsOf(tenantId, date),
  ]);

  const byCustomer = new Map<string, BucketAmounts>();
  for (const invoice of open) {
    const buckets = byCustomer.get(invoice.customer_id) ?? emptyBuckets();
    buckets[agingBucket(ageOf(invoice, date))] += Number(invoice.open_minor);
    byCustomer.set(invoice.customer_id, buckets);
  }

  const totals = { buckets: emptyBuckets(), invoiced: 0, notInvoiced: 0, balance: 0 };
  const rows: AgingRow[] = [];
  for (const customer of customers) {
    const buckets = byCustomer.get(customer.id) ?? emptyBuckets();
    const invoiced = AGING_BUCKETS.reduce((sum, b) => sum + buckets[b], 0);
    const balance = Number(customer.balance_minor);
    if (invoiced === 0 && balance === 0) {
      continue;
    }
    const notInvoiced = balance - invoiced;
    for (const b of AGING_BUCKETS) {
      totals.buckets[b] += buckets[b];
    }
    totals.invoiced += invoiced;
    totals.notInvoiced += notInvoiced;
    totals.balance += balance;
    rows.push({
      customer_id: customer.id,
      customer_name: customer.name,
      ...bucketFields(buckets),
      invoiced_minor: String(invoiced),
      not_invoiced_minor: String(notInvoiced),
      balance_minor: String(balance),
    });
  }
  rows.sort(
    (a, b) => Number(b["balance_minor"]) - Number(a["balance_minor"]) || a["customer_name"]!.localeCompare(b["customer_name"]!),
  );

  return {
    as_of: date,
    currency: tenant.base_currency,
    buckets: AGING_BUCKETS,
    rows,
    totals: {
      ...bucketFields(totals.buckets),
      invoiced_minor: String(totals.invoiced),
      not_invoiced_minor: String(totals.notInvoiced),
      balance_minor: String(totals.balance),
    },
  };
}

/** Drill-down: one customer's open invoices at the as-of date (FR-RPT-03). */
export async function getCustomerAging(tenantId: string, customerId: string, asOf?: string): Promise<CustomerAgingDetail> {
  const date = asOf ?? todayInNairobi();
  const customer = await customersService.getCustomer(tenantId, customerId, date);
  const [tenant, open] = await Promise.all([
    tenantsService.getTenant(tenantId),
    invoicesService.listOpenInvoicesAsOf(tenantId, date, customerId),
  ]);
  const invoiced = open.reduce((sum, i) => sum + Number(i.open_minor), 0);
  const balance = Number(customer.balance_minor);
  return {
    as_of: date,
    currency: tenant.base_currency,
    customer_id: customer.id,
    customer_name: customer.name,
    invoices: open.map((invoice) => {
      const days = ageOf(invoice, date);
      return {
        id: invoice.id,
        number: invoice.number,
        issue_date: invoice.issue_date,
        due_date: invoice.due_date,
        days_past_due: Math.max(days, 0),
        bucket: agingBucket(days),
        total_minor: invoice.total_minor,
        open_minor: invoice.open_minor,
      };
    }),
    invoiced_minor: String(invoiced),
    not_invoiced_minor: String(balance - invoiced),
    balance_minor: String(balance),
  };
}
