/**
 * Suppliers repository.
 *
 * The ONLY file permitted to write raw SQL against the `suppliers` table
 * (AD-02: "a module MUST own its tables exclusively"). Every write goes
 * through recordAuditLog inside the SAME transaction, per FR-AUD-01.
 *
 * Mirrors customers/repository.ts, except a supplier's balance sits on the
 * credit side (money we owe them, AP-like) instead of the debit side.
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_SUPPLIER_TYPES, DomainError, type SupplierPaymentMethod } from "@jibuks/domain";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";

export type TxClient = Parameters<Parameters<typeof withTenant>[1]>[0];

export interface SupplierRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly is_active: boolean;
  readonly tags: string[];
  readonly tax_identifier: string | null;
  readonly payment_terms_days: number | null;
  /** Null means the tenant's base currency. */
  readonly currency: string | null;
  /** SUP-0001, gapless per business. */
  readonly code: string;
  readonly supplier_type_id: string | null;
  readonly city: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly country: string | null;
  readonly postal_code: string | null;
  readonly vat_registered: boolean;
  /** Basis points; null = not set. */
  readonly default_tax_rate_bps: number | null;
  readonly preferred_payment_method: SupplierPaymentMethod | null;
  readonly bank_name: string | null;
  readonly bank_account_number: string | null;
  readonly mpesa_phone: string | null;
  readonly mpesa_paybill_till: string | null;
  readonly created_at: string;
}

/** A SupplierRow plus its computed balance -- what GET /suppliers and GET
 * /suppliers/{id} return. Net of POSTED journal_lines tagged with this
 * supplier, hardcoded to the credit side (money owed to them is a credit
 * balance, the same as a LIABILITY account's natural side). bigint sum
 * comes back from pg as a string. */
export interface SupplierWithBalanceRow extends SupplierRow {
  readonly supplier_type_name: string | null;
  readonly balance_minor: string;
}

/** A SupplierWithBalanceRow plus the id, date and source of its latest posted journal (all null if none). */
export interface SupplierWithActivityRow extends SupplierWithBalanceRow {
  readonly last_activity_journal_id: string | null;
  readonly last_activity_date: string | null;
  readonly last_activity_source: string | null;
}

/** The supplier's most recent POSTED journal -- what the "last activity" is built from (supplierLedger names it). */
function lastActivityJoin(asOfParamIndex: number | null): string {
  const asOfClause = asOfParamIndex !== null ? ` AND j.date <= $${asOfParamIndex}` : "";
  return `
    LEFT JOIN LATERAL (
      SELECT j.id AS last_activity_journal_id, j.date::text AS last_activity_date, j.source AS last_activity_source
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'${asOfClause}
      WHERE jl.supplier_id = base.id
      ORDER BY j.date DESC, j.created_at DESC, j.id DESC
      LIMIT 1
    ) la ON true
  `;
}

/** Mirrors customers/repository.ts's balanceJoin, keyed on
 * journal_lines.supplier_id. Only POSTED journals count (FR-ACC-02). */
function balanceJoin(asOfParamIndex: number | null): string {
  const asOfClause = asOfParamIndex !== null ? ` AND j.date <= $${asOfParamIndex}` : "";
  return `
    LEFT JOIN journal_lines jl ON jl.supplier_id = s.id
    LEFT JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'${asOfClause}
  `;
}

const BALANCE_EXPR = `
  COALESCE(SUM(
    CASE WHEN j.id IS NULL THEN 0
         ELSE jl.credit_minor - jl.debit_minor
    END
  ), 0)::text AS balance_minor
`;

export interface CreateSupplierInput {
  readonly tenantId: string;
  /** Chosen by the caller when something else must point at the supplier in the same transaction. */
  readonly id?: string;
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address?: string;
  readonly tags?: string[];
  readonly taxIdentifier?: string;
  readonly paymentTermsDays?: number;
  readonly currency?: string;
  readonly supplierTypeId?: string;
  readonly city?: string;
  readonly country?: string;
  readonly postalCode?: string;
  readonly vatRegistered?: boolean;
  readonly defaultTaxRateBps?: number;
  readonly preferredPaymentMethod?: SupplierPaymentMethod;
  readonly bankName?: string;
  readonly bankAccountNumber?: string;
  readonly mpesaPhone?: string;
  readonly mpesaPaybillTill?: string;
  readonly isActive?: boolean;
}

async function ensureSupplierType(client: TxClient, supplierTypeId: string): Promise<void> {
  const found = await client.query(`SELECT 1 FROM supplier_types WHERE id = $1`, [supplierTypeId]);
  if (found.rows.length === 0) {
    throw new DomainError("SUPPLIER_TYPE_NOT_FOUND", `Supplier type ${supplierTypeId} not found`);
  }
}

/** Inserts the supplier, with the next SUP- code, inside the caller's transaction. */
export async function insertSupplier(client: TxClient, input: CreateSupplierInput, audit: AuditContext): Promise<SupplierRow> {
  if (input.supplierTypeId !== undefined) {
    await ensureSupplierType(client, input.supplierTypeId);
  }
  const sequence = await client.query<{ last_value: number }>(
    `INSERT INTO supplier_code_sequences (tenant_id, last_value) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_value = supplier_code_sequences.last_value + 1
     RETURNING last_value`,
    [input.tenantId],
  );
  const code = `SUP-${String(sequence.rows[0]!.last_value).padStart(4, "0")}`;

  const result = await client.query<SupplierRow>(
    `INSERT INTO suppliers (id, tenant_id, name, phone, email, address, tags, tax_identifier, payment_terms_days, currency,
                            code, supplier_type_id, city, country, postal_code, vat_registered, default_tax_rate_bps,
                            preferred_payment_method, bank_name, bank_account_number, mpesa_phone, mpesa_paybill_till, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     RETURNING *`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.name,
      input.phone ?? null,
      input.email ?? null,
      input.address ?? null,
      input.tags ?? [],
      input.taxIdentifier ?? null,
      input.paymentTermsDays ?? null,
      input.currency ?? null,
      code,
      input.supplierTypeId ?? null,
      input.city ?? null,
      input.country ?? null,
      input.postalCode ?? null,
      input.vatRegistered ?? false,
      input.defaultTaxRateBps ?? null,
      input.preferredPaymentMethod ?? null,
      input.bankName ?? null,
      input.bankAccountNumber ?? null,
      input.mpesaPhone ?? null,
      input.mpesaPaybillTill ?? null,
      input.isActive ?? true,
    ],
  );

  const supplier = result.rows[0]!;

  await recordAuditLog(client, {
    tenantId: input.tenantId,
    action: "CREATE",
    entityType: "supplier",
    entityId: supplier.id,
    afterState: supplier,
    context: audit,
  });

  return supplier;
}

export async function createSupplier(input: CreateSupplierInput, audit: AuditContext): Promise<SupplierRow> {
  return withTenant(input.tenantId, (client) => insertSupplier(client, input, audit));
}

export interface ListSuppliersFilters {
  readonly asOf?: string | undefined;
  /** Case-insensitive match on name, code, phone or email. */
  readonly q?: string | undefined;
  readonly supplierTypeId?: string | undefined;
}

export async function listSuppliers(tenantId: string, filters: ListSuppliersFilters = {}): Promise<SupplierWithActivityRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    let asOfParamIndex: number | null = null;
    if (filters.asOf) {
      params.push(filters.asOf);
      asOfParamIndex = params.length;
    }
    const where: string[] = [];
    if (filters.q) {
      // Escape LIKE wildcards so "50%" searches for the text.
      params.push(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`);
      const p = `$${params.length}`;
      where.push(`(s.name ILIKE ${p} OR s.code ILIKE ${p} OR s.phone ILIKE ${p} OR s.email ILIKE ${p})`);
    }
    if (filters.supplierTypeId) {
      params.push(filters.supplierTypeId);
      where.push(`s.supplier_type_id = $${params.length}`);
    }

    const result = await client.query<SupplierWithActivityRow>(
      `SELECT base.*, la.*
       FROM (
         SELECT s.*, st.name AS supplier_type_name, ${BALANCE_EXPR}
         FROM suppliers s
         LEFT JOIN supplier_types st ON st.id = s.supplier_type_id
         ${balanceJoin(asOfParamIndex)}
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         GROUP BY s.id, st.name
       ) base
       ${lastActivityJoin(asOfParamIndex)}
       ORDER BY base.name ASC`,
      params,
    );
    return result.rows;
  });
}

export async function getSupplierById(
  tenantId: string,
  supplierId: string,
  asOf?: string,
): Promise<SupplierWithActivityRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [supplierId];
    let asOfParamIndex: number | null = null;
    if (asOf) {
      params.push(asOf);
      asOfParamIndex = params.length;
    }

    const result = await client.query<SupplierWithActivityRow>(
      `SELECT base.*, la.*
       FROM (
         SELECT s.*, st.name AS supplier_type_name, ${BALANCE_EXPR}
         FROM suppliers s
         LEFT JOIN supplier_types st ON st.id = s.supplier_type_id
         ${balanceJoin(asOfParamIndex)}
         WHERE s.id = $1
         GROUP BY s.id, st.name
       ) base
       ${lastActivityJoin(asOfParamIndex)}`,
      params,
    );
    return result.rows[0] ?? null;
  });
}

/** One POSTED journal's net effect on a supplier -- a row of their ledger. */
export interface SupplierLedgerJournalRow {
  readonly journal_id: string;
  readonly supplier_id: string;
  readonly date: string;
  readonly journal_number: string | null;
  readonly reference: string | null;
  readonly description: string;
  readonly source: string;
  readonly debit_minor: string; // bigint
  readonly credit_minor: string;
}

const LEDGER_COLUMNS = `j.id AS journal_id, jl.supplier_id, j.date::text AS date, j.number AS journal_number, j.reference,
  j.description, j.source, SUM(jl.debit_minor)::text AS debit_minor, SUM(jl.credit_minor)::text AS credit_minor`;

/** Every POSTED journal tagged with this supplier in [from, to], oldest
 * first, its supplier-tagged lines summed (a journal normally has one). */
export async function listLedgerJournals(
  tenantId: string,
  supplierId: string,
  from?: string,
  to?: string,
): Promise<SupplierLedgerJournalRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [supplierId];
    const where = ["jl.supplier_id = $1"];
    if (from) {
      params.push(from);
      where.push(`j.date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      where.push(`j.date <= $${params.length}`);
    }
    const result = await client.query<SupplierLedgerJournalRow>(
      `SELECT ${LEDGER_COLUMNS}
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
       WHERE ${where.join(" AND ")}
       GROUP BY j.id, jl.supplier_id
       ORDER BY j.date, j.created_at, j.id`,
      params,
    );
    return result.rows;
  });
}

/** The latest POSTED journals tagged with any supplier, on or before `asOf`, newest first -- one row per journal and supplier. */
export async function listRecentLedgerJournals(tenantId: string, asOf: string, limit: number): Promise<SupplierLedgerJournalRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<SupplierLedgerJournalRow>(
      `SELECT ${LEDGER_COLUMNS}
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
       WHERE jl.supplier_id IS NOT NULL AND j.date <= $1
       GROUP BY j.id, jl.supplier_id
       ORDER BY j.date DESC, j.created_at DESC, j.id DESC
       LIMIT $2`,
      [asOf, limit],
    );
    return result.rows;
  });
}

/** The supplier's balance (what the business owes them) from POSTED journals dated before `date`. */
export async function balanceBefore(tenantId: string, supplierId: string, date: string): Promise<number> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<{ balance_minor: string }>(
      `SELECT COALESCE(SUM(jl.credit_minor - jl.debit_minor), 0)::text AS balance_minor
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
       WHERE jl.supplier_id = $1 AND j.date < $2`,
      [supplierId, date],
    );
    return Number(result.rows[0]!.balance_minor);
  });
}

/** Suppliers are never deleted, only deactivated (same FR-COA-03 philosophy
 * applied to a name list -- history against a supplier must stay retrievable). */
export async function deactivateSupplier(
  tenantId: string,
  supplierId: string,
  audit: AuditContext,
): Promise<SupplierRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<SupplierRow>(`SELECT * FROM suppliers WHERE id = $1`, [supplierId]);
    if (before.rows.length === 0) {
      return null;
    }

    const result = await client.query<SupplierRow>(
      `UPDATE suppliers SET is_active = false WHERE id = $1 RETURNING *`,
      [supplierId],
    );
    const supplier = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "supplier",
      entityId: supplier.id,
      beforeState: before.rows[0],
      afterState: supplier,
      context: audit,
    });

    return supplier;
  });
}

export async function reactivateSupplier(
  tenantId: string,
  supplierId: string,
  audit: AuditContext,
): Promise<SupplierRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<SupplierRow>(`SELECT * FROM suppliers WHERE id = $1`, [supplierId]);
    if (before.rows.length === 0) {
      return null;
    }

    const result = await client.query<SupplierRow>(
      `UPDATE suppliers SET is_active = true WHERE id = $1 RETURNING *`,
      [supplierId],
    );
    const supplier = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "supplier",
      entityId: supplier.id,
      beforeState: before.rows[0],
      afterState: supplier,
      context: audit,
    });

    return supplier;
  });
}

export interface UpdateSupplierInput {
  readonly name?: string | undefined;
  readonly phone?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly tags?: string[] | undefined;
  readonly taxIdentifier?: string | null | undefined;
  readonly paymentTermsDays?: number | null | undefined;
  readonly currency?: string | null | undefined;
  readonly supplierTypeId?: string | null | undefined;
  readonly city?: string | null | undefined;
  readonly country?: string | null | undefined;
  readonly postalCode?: string | null | undefined;
  readonly vatRegistered?: boolean | undefined;
  readonly defaultTaxRateBps?: number | null | undefined;
  readonly preferredPaymentMethod?: SupplierPaymentMethod | null | undefined;
  readonly bankName?: string | null | undefined;
  readonly bankAccountNumber?: string | null | undefined;
  readonly mpesaPhone?: string | null | undefined;
  readonly mpesaPaybillTill?: string | null | undefined;
}

const UPDATABLE_COLUMNS: Readonly<Record<keyof UpdateSupplierInput, string>> = {
  name: "name",
  phone: "phone",
  email: "email",
  address: "address",
  tags: "tags",
  taxIdentifier: "tax_identifier",
  paymentTermsDays: "payment_terms_days",
  currency: "currency",
  supplierTypeId: "supplier_type_id",
  city: "city",
  country: "country",
  postalCode: "postal_code",
  vatRegistered: "vat_registered",
  defaultTaxRateBps: "default_tax_rate_bps",
  preferredPaymentMethod: "preferred_payment_method",
  bankName: "bank_name",
  bankAccountNumber: "bank_account_number",
  mpesaPhone: "mpesa_phone",
  mpesaPaybillTill: "mpesa_paybill_till",
};

/**
 * Applies only the fields present in `input` (null clears a column).
 * Currency can't change once any journal line references this supplier --
 * their balance and credit limit would silently change meaning.
 */
export async function updateSupplier(
  tenantId: string,
  supplierId: string,
  input: UpdateSupplierInput,
  audit: AuditContext,
): Promise<SupplierRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<SupplierRow>(`SELECT * FROM suppliers WHERE id = $1 FOR UPDATE`, [supplierId]);
    const existing = before.rows[0];
    if (!existing) {
      return null;
    }

    if (input.currency !== undefined && input.currency !== existing.currency) {
      const used = await client.query(`SELECT 1 FROM journal_lines WHERE supplier_id = $1 LIMIT 1`, [supplierId]);
      if (used.rows.length > 0) {
        throw new DomainError(
          "PARTY_CURRENCY_LOCKED",
          `Supplier ${supplierId} already has transactions; its currency can no longer be changed`,
        );
      }
    }

    const vatRegistered = input.vatRegistered ?? existing.vat_registered;
    const taxRate = input.defaultTaxRateBps !== undefined ? input.defaultTaxRateBps : existing.default_tax_rate_bps;
    if (!vatRegistered && taxRate !== null && taxRate > 0) {
      throw new DomainError("TAX_NOT_REGISTERED", "A supplier that isn't VAT registered charges no VAT; set vatRegistered or clear defaultTaxRateBps");
    }
    if (input.supplierTypeId) {
      await ensureSupplierType(client, input.supplierTypeId);
    }

    const entries = (Object.keys(UPDATABLE_COLUMNS) as (keyof UpdateSupplierInput)[]).filter(
      (key) => input[key] !== undefined,
    );
    const assignments = entries.map((key, i) => `${UPDATABLE_COLUMNS[key]} = $${i + 2}`);
    const result = await client.query<SupplierRow>(
      `UPDATE suppliers SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
      [supplierId, ...entries.map((key) => input[key])],
    );
    const supplier = result.rows[0]!;

    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "supplier",
      entityId: supplier.id,
      beforeState: existing,
      afterState: supplier,
      context: audit,
    });

    return supplier;
  });
}

// ---------------------------------------------------------------------
// Supplier types -- each business's list behind the Supplier Type dropdown.
// ---------------------------------------------------------------------

export interface SupplierTypeRow {
  readonly id: string;
  readonly name: string;
  readonly supplier_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const TYPE_COLUMNS = "id, name, created_at, updated_at";

export async function listSupplierTypes(tenantId: string): Promise<SupplierTypeRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<SupplierTypeRow>(
      `SELECT st.id, st.name, st.created_at, st.updated_at, count(s.id)::int AS supplier_count
       FROM supplier_types st
       LEFT JOIN suppliers s ON s.supplier_type_id = st.id
       GROUP BY st.id
       ORDER BY lower(st.name)`,
    );
    return result.rows;
  });
}

/** Gives a new business the starting list. Does nothing for one that already has types. */
export async function seedDefaultSupplierTypes(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO supplier_types (tenant_id, name)
       SELECT $1, name FROM unnest($2::text[]) AS d(name)
       WHERE NOT EXISTS (SELECT 1 FROM supplier_types)`,
      [tenantId, DEFAULT_SUPPLIER_TYPES],
    );
  });
}

export async function createSupplierType(tenantId: string, name: string, audit: AuditContext): Promise<SupplierTypeRow> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<Omit<SupplierTypeRow, "supplier_count">>(
      `INSERT INTO supplier_types (tenant_id, name) VALUES ($1, $2) RETURNING ${TYPE_COLUMNS}`,
      [tenantId, name],
    );
    const type = { ...result.rows[0]!, supplier_count: 0 };
    await recordAuditLog(client, {
      tenantId,
      action: "CREATE",
      entityType: "supplier_type",
      entityId: type.id,
      afterState: type,
      context: audit,
    });
    return type;
  });
}

export async function renameSupplierType(
  tenantId: string,
  supplierTypeId: string,
  name: string,
  audit: AuditContext,
): Promise<SupplierTypeRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<Omit<SupplierTypeRow, "supplier_count">>(
      `SELECT ${TYPE_COLUMNS} FROM supplier_types WHERE id = $1 FOR UPDATE`,
      [supplierTypeId],
    );
    if (before.rows.length === 0) {
      return null;
    }
    const result = await client.query<Omit<SupplierTypeRow, "supplier_count">>(
      `UPDATE supplier_types SET name = $2, updated_at = now() WHERE id = $1 RETURNING ${TYPE_COLUMNS}`,
      [supplierTypeId, name],
    );
    const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM suppliers WHERE supplier_type_id = $1`, [
      supplierTypeId,
    ]);
    const type = { ...result.rows[0]!, supplier_count: count.rows[0]!.n };
    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "supplier_type",
      entityId: type.id,
      beforeState: before.rows[0],
      afterState: type,
      context: audit,
    });
    return type;
  });
}
