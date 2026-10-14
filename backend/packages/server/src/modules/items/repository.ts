/**
 * Items repository.
 *
 * The ONLY file permitted to write raw SQL against `items` (AD-02). Every
 * write is audit-logged in the same transaction (FR-AUD-01).
 */

import { randomUUID } from "node:crypto";
import { recordAuditLog, withTenant, readAsTenant, type AuditContext } from "@jibuks/db";
import type { ItemType } from "@jibuks/domain";

export interface ItemRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly type: ItemType;
  readonly name: string;
  readonly parent_item_id: string | null;
  readonly unit_of_measure: string | null;
  readonly rate_minor: string | null; // bigint
  readonly income_account_id: string | null;
  readonly expense_account_id: string | null;
  readonly inventory_account_id: string | null;
  readonly track_stock: boolean;
  readonly description: string | null;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/** An ItemRow plus its name with its parents', e.g. "Haircut: Kids" -- what pickers show. */
export interface ItemWithPathRow extends ItemRow {
  readonly full_name: string;
}

/** Every item with its full_name, built by walking up parent_item_id. */
const ITEMS_WITH_PATH = `
  WITH RECURSIVE path AS (
    SELECT id, name::text AS full_name FROM items WHERE parent_item_id IS NULL
    UNION ALL
    SELECT i.id, path.full_name || ': ' || i.name FROM items i JOIN path ON i.parent_item_id = path.id
  )
  SELECT items.*, path.full_name FROM items JOIN path ON path.id = items.id`;

export interface ItemColumns {
  readonly type: ItemType;
  readonly name: string;
  readonly parentItemId: string | null;
  readonly unitOfMeasure: string | null;
  readonly rateMinor: number | null;
  readonly incomeAccountId: string | null;
  readonly expenseAccountId: string | null;
  readonly inventoryAccountId: string | null;
  readonly trackStock: boolean;
  readonly description: string | null;
}

export async function createItem(
  tenantId: string,
  input: ItemColumns & { readonly isActive: boolean },
  audit: AuditContext,
): Promise<ItemRow> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<ItemRow>(
      `INSERT INTO items
         (id, tenant_id, type, name, parent_item_id, unit_of_measure, rate_minor, income_account_id,
          expense_account_id, inventory_account_id, track_stock, description, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        randomUUID(),
        tenantId,
        input.type,
        input.name,
        input.parentItemId,
        input.unitOfMeasure,
        input.rateMinor,
        input.incomeAccountId,
        input.expenseAccountId,
        input.inventoryAccountId,
        input.trackStock,
        input.description,
        input.isActive,
      ],
    );
    const item = result.rows[0]!;
    await recordAuditLog(client, {
      tenantId,
      action: "CREATE",
      entityType: "item",
      entityId: item.id,
      afterState: item,
      context: audit,
    });
    return item;
  });
}

export interface ListItemsFilters {
  readonly type?: ItemType;
  readonly active?: boolean;
  readonly q?: string;
  readonly parentItemId?: string;
}

/** Sorted by full name, so sub-items sit under their parent. */
export async function listItems(tenantId: string, filters: ListItemsFilters): Promise<ItemWithPathRow[]> {
  return readAsTenant(tenantId, async (client) => {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filters.type !== undefined) {
      where.push(`items.type = ${add(filters.type)}`);
    }
    if (filters.active !== undefined) {
      where.push(`items.is_active = ${add(filters.active)}`);
    }
    if (filters.q !== undefined) {
      // Escape LIKE wildcards so "50%" searches for the text.
      where.push(`path.full_name ILIKE ${add(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`)}`);
    }
    if (filters.parentItemId !== undefined) {
      where.push(`items.parent_item_id = ${add(filters.parentItemId)}`);
    }
    const result = await client.query<ItemWithPathRow>(
      `${ITEMS_WITH_PATH}
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY lower(path.full_name), items.id`,
      params,
    );
    return result.rows;
  });
}

export async function getItem(tenantId: string, itemId: string): Promise<ItemWithPathRow | null> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query<ItemWithPathRow>(`${ITEMS_WITH_PATH} WHERE items.id = $1`, [itemId]);
    return result.rows[0] ?? null;
  });
}

/** True if `candidateParentId` is `itemId` or one of its sub-items -- i.e. the move would make a loop. */
export async function wouldCreateCycle(tenantId: string, itemId: string, candidateParentId: string): Promise<boolean> {
  return readAsTenant(tenantId, async (client) => {
    const result = await client.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_item_id FROM items WHERE id = $2
         UNION ALL
         SELECT i.id, i.parent_item_id FROM items i JOIN up ON i.id = up.parent_item_id
       )
       SELECT 1 FROM up WHERE id = $1 LIMIT 1`,
      [itemId, candidateParentId],
    );
    return result.rows.length > 0;
  });
}

/** Replaces every editable column with `next`. Returns null if the item doesn't exist. */
export async function updateItem(
  tenantId: string,
  itemId: string,
  next: ItemColumns,
  audit: AuditContext,
): Promise<ItemRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<ItemRow>(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [itemId]);
    if (!before.rows[0]) {
      return null;
    }
    const result = await client.query<ItemRow>(
      `UPDATE items
          SET type = $2, name = $3, parent_item_id = $4, unit_of_measure = $5, rate_minor = $6,
              income_account_id = $7, expense_account_id = $8, inventory_account_id = $9,
              track_stock = $10, description = $11, updated_at = now()
        WHERE id = $1
       RETURNING *`,
      [
        itemId,
        next.type,
        next.name,
        next.parentItemId,
        next.unitOfMeasure,
        next.rateMinor,
        next.incomeAccountId,
        next.expenseAccountId,
        next.inventoryAccountId,
        next.trackStock,
        next.description,
      ],
    );
    const item = result.rows[0]!;
    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "item",
      entityId: itemId,
      beforeState: before.rows[0],
      afterState: item,
      context: audit,
    });
    return item;
  });
}

/** Items are never deleted, only deactivated, so history naming them stays readable. */
export async function setItemActive(
  tenantId: string,
  itemId: string,
  isActive: boolean,
  audit: AuditContext,
): Promise<ItemRow | null> {
  return withTenant(tenantId, async (client) => {
    const before = await client.query<ItemRow>(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [itemId]);
    if (!before.rows[0]) {
      return null;
    }
    const result = await client.query<ItemRow>(
      `UPDATE items SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [itemId, isActive],
    );
    const item = result.rows[0]!;
    await recordAuditLog(client, {
      tenantId,
      action: "UPDATE",
      entityType: "item",
      entityId: itemId,
      beforeState: before.rows[0],
      afterState: item,
      context: audit,
    });
    return item;
  });
}
