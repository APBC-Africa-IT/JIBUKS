/**
 * Bills service -- the guided Write Bill endpoint.
 *
 * A bill is the Purchases Day Book entry of manual bookkeeping, the
 * supplier-side mirror of Credit Sale:
 *   Dr Expense/Asset line(s) (net)
 *   Dr Input Tax (if any -- reclaimable, unlike a sale's tax credit)
 *     Cr Accounts Payable (gross, tagged to the supplier)
 * Posts through the same journals module and @jibuks/ledger
 * validateForPosting path as everything else -- no special treatment.
 */

import type { CurrencyCode } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import type { JournalWithLines } from "../journals/repository.js";
import * as journalsService from "../journals/service.js";

export interface BillLineRequest {
  readonly expenseAccountId: string;
  readonly amountMinor: number;
  readonly narrative?: string;
}

export interface CreateWriteBillRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly supplierId: string;
  readonly payableAccountId: string;
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly reference?: string;
  readonly description?: string;
  readonly lines: readonly BillLineRequest[];
  readonly taxAccountId?: string;
  readonly taxAmountMinor?: number;
}

export async function createWriteBill(request: CreateWriteBillRequest, audit: AuditContext): Promise<JournalWithLines> {
  const taxAmountMinor = request.taxAmountMinor ?? 0;
  const netTotal = request.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const grossTotal = netTotal + taxAmountMinor;
  const description = request.description ?? "Bill";

  return journalsService.createJournal(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      date: request.date,
      currency: request.currency,
      description,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      source: "BILL",
      lines: [
        ...request.lines.map((line) => ({
          accountId: line.expenseAccountId,
          debitMinor: line.amountMinor,
          creditMinor: 0,
          ...(line.narrative !== undefined ? { narrative: line.narrative } : {}),
        })),
        ...(taxAmountMinor > 0
          ? [
              {
                // Presence of taxAccountId whenever taxAmountMinor > 0 is
                // enforced by createWriteBillSchema before this is reached.
                accountId: request.taxAccountId!,
                debitMinor: taxAmountMinor,
                creditMinor: 0,
                narrative: "Input tax",
              },
            ]
          : []),
        {
          accountId: request.payableAccountId,
          debitMinor: 0,
          creditMinor: grossTotal,
          supplierId: request.supplierId,
          narrative: description,
        },
      ],
    },
    audit,
  );
}
