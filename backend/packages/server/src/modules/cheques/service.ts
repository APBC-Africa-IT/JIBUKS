/**
 * Cheques service -- the guided Write Cheque endpoint.
 *
 * A cheque is the Cash Payments Book entry of manual bookkeeping: a
 * payment OUT. Unlike Credit Sale/Cash Sale/Write Bill, there is no single
 * well-known "other side" account type -- a cheque might clear part of a
 * supplier's outstanding bill (accountId = AP, supplierId set), pay an
 * expense directly, or both in the same cheque. Every line is just a debit
 * against whatever the payment is for:
 *   Dr <line accountId>(s)
 *     Cr Bank (gross)
 * Posts through the same journals module and @jibuks/ledger
 * validateForPosting path as everything else -- no special treatment.
 */

import type { CurrencyCode } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import type { JournalWithLines } from "../journals/repository.js";
import * as journalsService from "../journals/service.js";

export interface WriteChequeLineRequest {
  readonly accountId: string;
  readonly amountMinor: number;
  readonly narrative?: string;
  readonly customerId?: string;
  readonly supplierId?: string;
}

export interface CreateWriteChequeRequest {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly bankAccountId: string;
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly reference?: string;
  readonly description?: string;
  readonly lines: readonly WriteChequeLineRequest[];
}

export async function createWriteCheque(request: CreateWriteChequeRequest, audit: AuditContext): Promise<JournalWithLines> {
  const grossTotal = request.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const description = request.description ?? "Cheque payment";

  return journalsService.createJournal(
    {
      tenantId: request.tenantId,
      clientUuid: request.clientUuid,
      ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
      date: request.date,
      currency: request.currency,
      description,
      ...(request.reference !== undefined ? { reference: request.reference } : {}),
      source: "PAYMENT",
      lines: [
        ...request.lines.map((line) => ({
          accountId: line.accountId,
          debitMinor: line.amountMinor,
          creditMinor: 0,
          ...(line.narrative !== undefined ? { narrative: line.narrative } : {}),
          ...(line.customerId !== undefined ? { customerId: line.customerId } : {}),
          ...(line.supplierId !== undefined ? { supplierId: line.supplierId } : {}),
        })),
        {
          accountId: request.bankAccountId,
          debitMinor: 0,
          creditMinor: grossTotal,
          narrative: description,
        },
      ],
    },
    audit,
  );
}
