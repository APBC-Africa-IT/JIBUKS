/**
 * Onboarding controller -- HTTP layer only.
 */

import type { Request, Response } from "express";
import { CHART_TEMPLATES, CHART_TEMPLATE_KEYS, onboardingRequestSchema } from "@jibuks/domain";
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
    vatRegistered: body.vatRegistered,
    periodStartDate: body.periodStartDate,
    chartTemplate: body.chartTemplate,
  });

  res.status(201).json(result);
}
/** The chart-of-accounts templates to choose from at sign-up (FR-COA-02). */
export function chartTemplates(_req: Request, res: Response): void {
  res.json({ data: CHART_TEMPLATE_KEYS.map((key) => CHART_TEMPLATES[key]) });
}
