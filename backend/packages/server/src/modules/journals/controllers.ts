/**
 * Journals controllers -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { createJournalRequestSchema } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as service from "./service.js";

function auditContextFrom(req: Request): AuditContext {
  const actorUserId = req.header("X-Actor-User-Id");
  if (!actorUserId) {
    throw new Error("X-Actor-User-Id header is required (temporary stand-in until identity/auth is built)");
  }
  return {
    actorUserId,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  };
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = createJournalRequestSchema.parse(req.body);
  const journal = await service.createJournal(
    {
      tenantId: req.tenantId!,
      clientUuid: body.clientUuid,
      ...(body.branchId ? { branchId: body.branchId } : {}),
      date: body.date,
      currency: body.currency,
      description: body.description,
      ...(body.reference ? { reference: body.reference } : {}),
      source: body.source,
      lines: body.lines.map((line) => ({
        accountId: line.accountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        ...(line.narrative ? { narrative: line.narrative } : {}),
        ...(line.projectId ? { projectId: line.projectId } : {}),
        ...(line.department ? { department: line.department } : {}),
      })),
    },
    auditContextFrom(req),
  );
  res.status(201).json(journal);
}

export async function list(req: Request, res: Response): Promise<void> {
  const journals = await service.listJournals(req.tenantId!);
  res.json({ data: journals });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const journal = await service.getJournal(req.tenantId!, req.params["id"]!);
  res.json(journal);
}

export async function reverse(req: Request, res: Response): Promise<void> {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "No reason provided";
  const journal = await service.reverseJournal(req.tenantId!, req.params["id"]!, reason, auditContextFrom(req));
  res.status(201).json(journal);
}