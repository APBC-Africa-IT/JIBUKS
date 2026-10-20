/**
 * Customer reports -- the Customers hub's Reports screen. Customer
 * balances, aging, activity and contacts are served by GET /customers,
 * /receivables-aging and /customers/{id}/transactions; this module adds
 * Collections: customers to follow up.
 *
 * A customer needs following up when an invoice is past due at the as-of
 * date. Built from the same open-invoice reconstruction as aging, so the
 * overdue amounts match GET /receivables-aging for that date.
 */

import { daysPastDue, type CustomerChannel } from "@jibuks/domain";
import * as customerPaymentsService from "../customerPayments/service.js";
import * as customersService from "../customers/service.js";
import * as documents from "../invoices/documents.js";
import { AR } from "../invoices/documents.js";
import { todayInNairobi } from "../periods/service.js";
import * as tenantsService from "../tenants/service.js";

export interface OverdueInvoice {
  readonly id: string;
  readonly number: string;
  readonly due_date: string;
  readonly days_overdue: number;
  readonly open_minor: string;
}

export interface FollowUpRow {
  readonly customer_id: string;
  readonly customer_name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly preferred_channel: CustomerChannel | null;
  readonly payment_reminders: boolean;
  /** What is past due. */
  readonly overdue_minor: string;
  readonly overdue_invoice_count: number;
  /** The most overdue invoice's due date and days past it. */
  readonly oldest_due_date: string;
  readonly days_overdue: number;
  /** Everything they owe at the as-of date, due or not, net of credit. */
  readonly balance_minor: string;
  readonly last_payment: { readonly date: string; readonly amount_minor: string; readonly number: string } | null;
  /** Most overdue first. */
  readonly invoices: OverdueInvoice[];
}

export interface FollowUpReport {
  readonly as_of: string;
  readonly currency: string;
  readonly min_days_overdue: number;
  readonly customer_count: number;
  readonly overdue_minor: string;
  /** Most days overdue first, then the larger amount. */
  readonly rows: FollowUpRow[];
}

export async function getCustomersToFollowUp(tenantId: string, asOf: string | undefined, minDaysOverdue: number): Promise<FollowUpReport> {
  const date = asOf ?? todayInNairobi();
  const [tenant, open, customers, lastPayments] = await Promise.all([
    tenantsService.getTenant(tenantId),
    documents.listOpenAsOf(AR, tenantId, date),
    customersService.listCustomers(tenantId, { asOf: date }),
    customerPaymentsService.latestPaymentByCustomer(tenantId, date),
  ]);

  const overdueByCustomer = new Map<string, OverdueInvoice[]>();
  for (const invoice of open) {
    const due = invoice.due_date ?? invoice.issue_date;
    const days = daysPastDue(due, date);
    if (days < minDaysOverdue) continue;
    const list = overdueByCustomer.get(invoice.party_id) ?? [];
    list.push({ id: invoice.id, number: invoice.number, due_date: due, days_overdue: days, open_minor: invoice.open_minor });
    overdueByCustomer.set(invoice.party_id, list);
  }

  const rows: FollowUpRow[] = [];
  for (const customer of customers) {
    const invoices = overdueByCustomer.get(customer.id);
    if (!invoices) continue;
    invoices.sort((a, b) => b.days_overdue - a.days_overdue || a.number.localeCompare(b.number));
    rows.push({
      customer_id: customer.id,
      customer_name: customer.name,
      phone: customer.phone,
      email: customer.email,
      preferred_channel: customer.preferred_channel,
      payment_reminders: customer.payment_reminders,
      overdue_minor: String(invoices.reduce((sum, i) => sum + Number(i.open_minor), 0)),
      overdue_invoice_count: invoices.length,
      oldest_due_date: invoices[0]!.due_date,
      days_overdue: invoices[0]!.days_overdue,
      balance_minor: customer.balance_minor,
      last_payment: lastPayments.get(customer.id) ?? null,
      invoices,
    });
  }
  rows.sort(
    (a, b) => b.days_overdue - a.days_overdue || Number(b.overdue_minor) - Number(a.overdue_minor) || a.customer_name.localeCompare(b.customer_name),
  );

  return {
    as_of: date,
    currency: tenant.base_currency,
    min_days_overdue: minDaysOverdue,
    customer_count: rows.length,
    overdue_minor: String(rows.reduce((sum, r) => sum + Number(r.overdue_minor), 0)),
    rows,
  };
}
