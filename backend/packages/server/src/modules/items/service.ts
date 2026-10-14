/**
 * Items service -- the product/service catalogue.
 *
 * An item carries the defaults a sales or purchase line picks up when the
 * item is chosen: price (rate_minor), the income account it sells into and
 * the account its purchases are debited to (inventory_account_id for
 * INVENTORY, else expense_account_id). Each account must be the right type.
 */

import { DomainError, isUuid, type AccountType, type ItemType } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as accountsService from "../accounts/service.js";
import * as repository from "./repository.js";
import type { ItemColumns, ItemRow, ItemWithPathRow, ListItemsFilters } from "./repository.js";

function notFound(itemId: string): DomainError {
  return new DomainError("ITEM_NOT_FOUND", `Item ${itemId} not found`);
}

export async function getItem(tenantId: string, itemId: string): Promise<ItemWithPathRow> {
  const item = isUuid(itemId) ? await repository.getItem(tenantId, itemId) : null;
  if (!item) {
    throw notFound(itemId);
  }
  return item;
}

export async function listItems(tenantId: string, filters: ListItemsFilters): Promise<ItemWithPathRow[]> {
  return repository.listItems(tenantId, filters);
}

async function assertAccountType(
  tenantId: string,
  accountId: string | null,
  allowed: readonly AccountType[],
  field: string,
): Promise<void> {
  if (accountId === null) {
    return;
  }
  const account = await accountsService.getAccount(tenantId, accountId);
  if (!allowed.includes(account.type)) {
    throw new DomainError(
      "ACCOUNT_WRONG_TYPE",
      `${field} must be ${allowed.join(" or ")} account; ${account.code} ${account.name} is ${account.type}`,
      [{ path: field, message: `Must be ${allowed.join(" or ")}` }],
    );
  }
}

/** Every rule on the item as it will be stored, so create and edit can't drift apart. */
async function validate(tenantId: string, itemId: string | null, item: ItemColumns): Promise<void> {
  if (item.type !== "INVENTORY" && item.trackStock) {
    throw new DomainError("ITEM_INVALID", "Only INVENTORY items can track stock", [
      { path: "trackStock", message: "Only INVENTORY items can track stock" },
    ]);
  }
  if (item.type !== "INVENTORY" && item.inventoryAccountId !== null) {
    throw new DomainError("ITEM_INVALID", "Only INVENTORY items have an inventory account", [
      { path: "inventoryAccountId", message: "Only INVENTORY items have an inventory account" },
    ]);
  }
  if (item.parentItemId !== null) {
    await getItem(tenantId, item.parentItemId); // 404 if it doesn't exist
    if (itemId !== null && (await repository.wouldCreateCycle(tenantId, itemId, item.parentItemId))) {
      throw new DomainError("ITEM_INVALID", "An item can't be a sub-item of itself or of one of its own sub-items", [
        { path: "parentItemId", message: "Would make a loop" },
      ]);
    }
  }
  await assertAccountType(tenantId, item.incomeAccountId, ["INCOME"], "incomeAccountId");
  await assertAccountType(tenantId, item.expenseAccountId, ["EXPENSE", "ASSET"], "expenseAccountId");
  await assertAccountType(tenantId, item.inventoryAccountId, ["ASSET"], "inventoryAccountId");
}

export interface CreateItemRequest {
  readonly tenantId: string;
  readonly type: ItemType;
  readonly name: string;
  readonly parentItemId?: string;
  readonly unitOfMeasure?: string;
  readonly rateMinor?: number;
  readonly incomeAccountId?: string;
  readonly expenseAccountId?: string;
  readonly inventoryAccountId?: string;
  readonly trackStock: boolean;
  readonly description?: string;
  readonly isActive: boolean;
}

export async function createItem(request: CreateItemRequest, audit: AuditContext): Promise<ItemWithPathRow> {
  const columns: ItemColumns = {
    type: request.type,
    name: request.name,
    parentItemId: request.parentItemId ?? null,
    unitOfMeasure: request.unitOfMeasure ?? null,
    rateMinor: request.rateMinor ?? null,
    incomeAccountId: request.incomeAccountId ?? null,
    expenseAccountId: request.expenseAccountId ?? null,
    inventoryAccountId: request.inventoryAccountId ?? null,
    trackStock: request.trackStock,
    description: request.description ?? null,
  };
  await validate(request.tenantId, null, columns);
  const item = await repository.createItem(request.tenantId, { ...columns, isActive: request.isActive }, audit);
  return getItem(request.tenantId, item.id);
}

/** Omitted fields are unchanged; null clears. */
export type UpdateItemRequest = { readonly [K in keyof ItemColumns]?: ItemColumns[K] };

export async function updateItem(
  tenantId: string,
  itemId: string,
  patch: UpdateItemRequest,
  audit: AuditContext,
): Promise<ItemWithPathRow> {
  const current = await getItem(tenantId, itemId);
  const pick = <K extends keyof ItemColumns>(key: K, stored: ItemColumns[K]): ItemColumns[K] =>
    patch[key] !== undefined ? (patch[key] as ItemColumns[K]) : stored;
  const next: ItemColumns = {
    type: pick("type", current.type),
    name: pick("name", current.name),
    parentItemId: pick("parentItemId", current.parent_item_id),
    unitOfMeasure: pick("unitOfMeasure", current.unit_of_measure),
    rateMinor: pick("rateMinor", current.rate_minor === null ? null : Number(current.rate_minor)),
    incomeAccountId: pick("incomeAccountId", current.income_account_id),
    expenseAccountId: pick("expenseAccountId", current.expense_account_id),
    inventoryAccountId: pick("inventoryAccountId", current.inventory_account_id),
    trackStock: pick("trackStock", current.track_stock),
    description: pick("description", current.description),
  };
  await validate(tenantId, itemId, next);
  if (!(await repository.updateItem(tenantId, itemId, next, audit))) {
    throw notFound(itemId);
  }
  return getItem(tenantId, itemId);
}

export async function setItemActive(
  tenantId: string,
  itemId: string,
  isActive: boolean,
  audit: AuditContext,
): Promise<ItemWithPathRow> {
  const updated: ItemRow | null = isUuid(itemId) ? await repository.setItemActive(tenantId, itemId, isActive, audit) : null;
  if (!updated) {
    throw notFound(itemId);
  }
  return getItem(tenantId, itemId);
}
