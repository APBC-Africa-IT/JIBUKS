/**
 * Cash sales service -- the guided cash-sale endpoint.
 *
 * A cash sale is the Cash Receipts Book entry of manual bookkeeping:
 *   Dr Cash/Bank (gross)
 *     Cr Revenue line(s) (net)
 *     Cr Tax Payable (VAT/sales tax, if any)
 * Unlike Credit Sale, payment is received immediately -- there is no
 * customer/AR subledger involved, so no line here ever carries a
 * customerId. Posts through the same journals module and
 * @jibuks/ledger validateForPosting path as everything else.
 */

import type { CurrencyCode } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import type { JournalWithLines } from "../journals/repository.js";
import * as journalsService from "../journals/service.js";

export interface CashSaleLineRequest {
  readonly incomeAccountId: string;
  readonly amountMinor: number;
  readonly narrative?: string;
}

export interface CreateCashSaleRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly receivedAccountId: string;
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly reference?: string;
  readonly description?: string;
  readonly lines: readonly CashSaleLineRequest[];
  readonly taxAccountId?: string;
  readonly taxAmountMinor?: number;
}

export async function createCashSale(request: CreateCashSaleRequest, audit: AuditContext): Promise<JournalWithLines> {
  const taxAmountMinor = request.taxAmountMinor ?? 0;
  const netTotal = request.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const grossTotal = netTotal + taxAmountMinor;
  const description = request.description ?? "Cash sale";

  return journalsService.createJournal(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      date: request.date,
      currency: request.currency,
      description,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      source: "CASHBOOK",
      lines: [
        {
          accountId: request.receivedAccountId,
          debitMinor: grossTotal,
          creditMinor: 0,
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
                // enforced by createCashSaleSchema before this is reached.
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
