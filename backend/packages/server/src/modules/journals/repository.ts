/**
 * Journals repository.
 *
 * The ONLY file permitted to write raw SQL against `journals` and
 * `journal_lines` (AD-02). Journals are inserted directly as POSTED --
 * by the time this function is called, @jibuks/ledger's validateForPosting
 * has already confirmed the journal balances and every line is valid. The
 * database's own deferred balance trigger (DR-04) and posted-immutability
 * trigger (FR-ACC-02) remain the second, independent line of defence.
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";

export interface JournalRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly branch_id: string | null;
  readonly client_uuid: string;
  readonly period_id: string;
  readonly date: string;
  readonly currency: string;
  readonly description: string;
  readonly reference: string | null;
  readonly source: string;
  readonly status: "DRAFT" | "PENDING_APPROVAL" | "POSTED";
  readonly reversal_of_journal_id: string | null;
  readonly created_by: string;
  readonly approved_by: string | null;
  readonly created_at: string;
}

export interface JournalLineRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly journal_id: string;
  readonly account_id: string;
  readonly debit_minor: string; // bigint comes back as string from pg
  readonly credit_minor: string;
  readonly narrative: string | null;
  readonly project_id: string | null;
  readonly department: string | null;
  readonly customer_id: string | null;
  readonly supplier_id: string | null;
}

export interface JournalWithLines extends JournalRow {
  readonly lines: JournalLineRow[];
}

export interface CreateJournalLineInput {
  readonly accountId: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly narrative?: string;
  readonly projectId?: string;
  readonly department?: string;
  readonly customerId?: string;
  readonly supplierId?: string;
}

export interface CreateJournalInput {
  readonly tenantId: string;
  readonly clientUuid: string;
  readonly branchId?: string;
  readonly periodId: string;
  readonly date: string;
  readonly currency: string;
  readonly description: string;
  readonly reference?: string;
  readonly source: string;
  readonly createdBy: string;
  readonly reversalOfJournalId?: string;
  readonly lines: readonly CreateJournalLineInput[];
}

export async function createJournal(input: CreateJournalInput, audit: AuditContext): Promise<JournalWithLines> {
  return withTenant(input.tenantId, async (client) => {
    const journalId = randomUUID();

    const journalResult = await client.query<JournalRow>(
      `INSERT INTO journals
         (id, tenant_id, branch_id, client_uuid, period_id, date, currency, description, reference, source, status, reversal_of_journal_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'POSTED', $11, $12)
       RETURNING *`,
      [
        journalId,
        input.tenantId,
        input.branchId ?? null,
        input.clientUuid,
        input.periodId,
        input.date,
        input.currency,
        input.description,
        input.reference ?? null,
        input.source,
        input.reversalOfJournalId ?? null,
        input.createdBy,
      ],
    );
    const journal = journalResult.rows[0]!;

    const lines: JournalLineRow[] = [];
    for (const line of input.lines) {
      const lineResult = await client.query<JournalLineRow>(
        `INSERT INTO journal_lines
           (id, tenant_id, journal_id, account_id, debit_minor, credit_minor, narrative, project_id, department, customer_id, supplier_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          randomUUID(),
          input.tenantId,
          journalId,
          line.accountId,
          line.debitMinor,
          line.creditMinor,
          line.narrative ?? null,
          line.projectId ?? null,
          line.department ?? null,
          line.customerId ?? null,
          line.supplierId ?? null,
        ],
      );
      lines.push(lineResult.rows[0]!);
    }

    await recordAuditLog(client, {
      tenantId: input.tenantId,
      action: "CREATE",
      entityType: "journal",
      entityId: journal.id,
      afterState: { ...journal, lines },
      context: audit,
    });

    // The deferred balance trigger (DR-04) fires when this transaction
    // commits, right after this callback returns. If the lines don't
    // balance, withTenant's COMMIT throws and the whole insert -- journal,
    // lines, and audit log alike -- rolls back together.
    return { ...journal, lines };
  });
}

export async function listJournals(tenantId: string): Promise<JournalRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<JournalRow>(`SELECT * FROM journals ORDER BY date DESC, created_at DESC`);
    return result.rows;
  });
}

export async function getJournalWithLines(tenantId: string, journalId: string): Promise<JournalWithLines | null> {
  return readAsTenant(tenantId, async (client) => {
    const journalResult = await client.query<JournalRow>(`SELECT * FROM journals WHERE id = $1`, [journalId]);
    const journal = journalResult.rows[0];
    if (!journal) {
      return null;
    }

    const linesResult = await client.query<JournalLineRow>(
      `SELECT * FROM journal_lines WHERE journal_id = $1 ORDER BY id`,
      [journalId],
    );

    return { ...journal, lines: linesResult.rows };
  });
}

export async function findJournalByReversalTarget(
  tenantId: string,
  originalJournalId: string,
): Promise<JournalRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<JournalRow>(
      `SELECT * FROM journals WHERE reversal_of_journal_id = $1`,
      [originalJournalId],
    );
    return result.rows[0] ?? null;
  });
}