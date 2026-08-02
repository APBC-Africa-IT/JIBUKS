/**
 * Onboarding controller -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { onboardingRequestSchema } from "@jibuks/domain";
import * as service from "./service.js";

export async function create(req: Request, res: Response): Promise<void> {
  const sub = req.auth?.payload?.sub;
  if (!sub || typeof sub !== "string") {
    throw new Error("Token did not carry a subject claim -- requireAuth0Token should have rejected this already");
  }

  const body = onboardingRequestSchema.parse(req.body);
  const result = await service.onboard({
    tenantName: body.tenantName,
    tenantType: body.tenantType,
    baseCurrency: body.baseCurrency,
    externalIdpSubject: sub,
    userName: body.userName,
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
  });

  res.status(201).json(result);
}