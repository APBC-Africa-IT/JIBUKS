/**
 * Roles controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { PERMISSIONS, createRoleSchema, updateRoleSchema } from "@jibuks/domain";
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

/** The fixed catalogue custom roles are composed from. */
export async function listPermissions(_req: Request, res: Response): Promise<void> {
  res.json({ data: PERMISSIONS });
}

export async function list(req: Request, res: Response): Promise<void> {
  const roles = await service.listRoles(req.tenantId!);
  res.json({ data: roles });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const role = await service.getRole(req.tenantId!, req.params["id"]!);
  res.json(role);
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = createRoleSchema.parse(req.body);
  const role = await service.createRole(
    {
      tenantId: req.tenantId!,
      name: body.name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      permissions: body.permissions,
    },
    auditContextFrom(req),
  );
  res.status(201).json(role);
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = updateRoleSchema.parse(req.body);
  const role = await service.updateRole(
    req.tenantId!,
    req.params["id"]!,
    {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
    },
    auditContextFrom(req),
  );
  res.json(role);
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const role = await service.setRoleActive(req.tenantId!, req.params["id"]!, false, auditContextFrom(req));
  res.json(role);
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  const role = await service.setRoleActive(req.tenantId!, req.params["id"]!, true, auditContextFrom(req));
  res.json(role);
}
