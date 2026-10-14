/**
 * Items controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createItemSchema, listItemsQuerySchema, updateItemSchema } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as service from "./service.js";

function auditContextFrom(req: Request): AuditContext {
  if (!req.actorUserId) {
    throw new Error("actorUserId missing -- requireRealIdentity should have set this");
  }
  return {
    actorUserId: req.actorUserId,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  };
}

/** Drops undefined values so optional fields stay absent (exactOptionalPropertyTypes). */
function defined<T extends object>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as never;
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = createItemSchema.parse(req.body);
  const item = await service.createItem({ ...defined(body), tenantId: req.tenantId! }, auditContextFrom(req));
  res.status(201).json(item);
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = listItemsQuerySchema.parse(req.query);
  const items = await service.listItems(
    req.tenantId!,
    defined({ type: query.type, active: query.active, q: query.q, parentItemId: query.parent_item_id }),
  );
  res.json({ data: items });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json(await service.getItem(req.tenantId!, req.params["id"]!));
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = updateItemSchema.parse(req.body);
  res.json(await service.updateItem(req.tenantId!, req.params["id"]!, defined(body), auditContextFrom(req)));
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  res.json(await service.setItemActive(req.tenantId!, req.params["id"]!, false, auditContextFrom(req)));
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  res.json(await service.setItemActive(req.tenantId!, req.params["id"]!, true, auditContextFrom(req)));
}
