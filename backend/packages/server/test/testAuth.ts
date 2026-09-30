/**
 * Shared test helper for authenticated requests.
 *
 * Uses ONE real Auth0 token via the client-credentials flow, fetched once
 * for the whole test run by globalSetup.ts and injected into every file --
 * avoids either faking token signing ourselves (which would mean maintaining a second, parallel implementation of what
 * requireAuth0Token verifies) or making a fresh network call per test
 * (slow, and makes the suite depend on Auth0 being reachable on every
 * single test).
 *
 * This token's `sub` is fixed to the Auth0 M2M application itself
 * (CLIENT_ID@clients), which maps to exactly one seeded row in `users`
 * (see the one-time seed migration/manual insert). Every authenticated
 * test therefore acts as this SAME tenant/user -- tests needing a SECOND,
 * isolated tenant seed one directly via withoutTenant, bypassing HTTP,
 * since there is no way to get a real token for an arbitrary tenant
 * without a full login flow.
 */

import { inject } from "vitest";
// Type-only: brings in the ProvidedContext declaration for inject().
import type {} from "./globalSetup.js";
import { fetchAuth0TestToken } from "./auth0Token.js";

export const TEST_TENANT_ID = "99999999-0000-4000-8000-000000000001";
export const TEST_USER_ID = "99999999-0000-4000-8000-000000000002";

let cachedToken: string | undefined;

export async function getTestToken(): Promise<string> {
  if (!cachedToken) {
    // Normally fetched once for the whole run by globalSetup.ts; fetch our
    // own only if that failed.
    cachedToken = inject("auth0TestToken") ?? (await fetchAuth0TestToken());
  }
  return cachedToken;
}

/** Convenience: the Authorization header value, ready to pass to .set(). */
export async function authHeader(): Promise<string> {
  return `Bearer ${await getTestToken()}`;
}