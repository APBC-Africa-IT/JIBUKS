/**
 * Credit sales service -- the guided sales-invoice endpoint.
 *
 * A credit sale is the Sales Day Book entry of manual bookkeeping:
 *   Dr Accounts Receivable (gross, tagged to the customer)
 *     Cr Revenue line(s) (net)
 *     Cr Tax Payable (VAT/sales tax, if any)
 * This module's only job is composing that balanced journal from the
 * invoice shape the client sends and posting it through the journals
 * module -- the same @jibuks/ledger validateForPosting path every other
 * journal goes through (period checks, account checks, customer/supplier
 * attribution checks). A credit sale gets no special treatment or shortcut.
 */

import type { CurrencyCode } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import type { JournalWithLines } from "../journals/repository.js";
import * as journalsService from "../journals/service.js";

export interface CreditSaleLineRequest {
  readonly incomeAccountId: string;
  readonly amountMinor: number;
  readonly narrative?: string;
}

export interface CreateCreditSaleRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly customerId: string;
  readonly receivableAccountId: string;
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly reference?: string;
  readonly description?: string;
  readonly lines: readonly CreditSaleLineRequest[];
  readonly taxAccountId?: string;
  readonly taxAmountMinor?: number;
}

export async function createCreditSale(request: CreateCreditSaleRequest, audit: AuditContext): Promise<JournalWithLines> {
  const taxAmountMinor = request.taxAmountMinor ?? 0;
  const netTotal = request.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const grossTotal = netTotal + taxAmountMinor;
  const description = request.description ?? "Credit sale";

  return journalsService.createJournal(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      date: request.date,
      currency: request.currency,
      description,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      source: "SALE",
      lines: [
        {
          accountId: request.receivableAccountId,
          debitMinor: grossTotal,
          creditMinor: 0,
          customerId: request.customerId,
          narrative: description,
        },
        ...request.lines.map((line) => ({
          accountId: line.incomeAccountId,
          debitMinor: 0,
          creditMinor: line.amountMinor,
          ...(line.narrative !== undefined ? { narrative: line.narrative } : {}),
        })),
        ...(taxAmountMinor > 0
          ? [
              {
                // Presence of taxAccountId whenever taxAmountMinor > 0 is
                // enforced by createCreditSaleSchema before this is reached.
                accountId: request.taxAccountId!,
                debitMinor: 0,
                creditMinor: taxAmountMinor,
                narrative: "Sales tax",
              },
            ]
          : []),
      ],
    },
    audit,
  );
}
