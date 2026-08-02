/**
 * Onboarding service -- the public interface of this module.
 */

import { DomainError } from "@jibuks/domain";
import * as usersService from "../users/service.js";
import * as repository from "./repository.js";
import type { OnboardResult } from "./repository.js";

export interface OnboardRequest {
  readonly tenantName: string;
  readonly tenantType: "BUSINESS" | "NGO" | "HOUSEHOLD";
  readonly baseCurrency: string;
  readonly externalIdpSubject: string;
  readonly userName: string;
  readonly email?: string;
  readonly phone?: string;
}

export async function onboard(request: OnboardRequest): Promise<OnboardResult> {
  const existing = await usersService.findByExternalIdpSubject(request.externalIdpSubject);
  if (existing) {
    throw new DomainError(
      "USER_ALREADY_EXISTS",
      `This identity is already onboarded (user ${existing.id}, tenant ${existing.tenant_id})`,
    );
  }

  return repository.onboardTenant(request);
}