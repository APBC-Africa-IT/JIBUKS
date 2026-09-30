/**
 * Vitest global setup: runs ONCE in the main process before any test
 * worker starts.
 *
 * Fetches a single Auth0 test token and provides it to every test file.
 * Without this, each file's worker fetched its own (module-level caches
 * don't survive vitest's per-file isolation) -- ~25 near-simultaneous
 * token requests per run, which Auth0 answered slowly enough to push the
 * first test in random files past the 5s timeout, and which burned
 * through the tenant's monthly M2M token quota.
 *
 * Failure here is not fatal: packages that need no token (domain, ledger,
 * db) still run, and testAuth.ts falls back to fetching its own.
 */

import type { GlobalSetupContext } from "vitest/node";
import { fetchAuth0TestToken } from "./auth0Token.js";

declare module "vitest" {
  export interface ProvidedContext {
    auth0TestToken: string | null;
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  try {
    provide("auth0TestToken", await fetchAuth0TestToken());
  } catch (err) {
    console.warn("globalSetup: could not fetch a shared Auth0 test token; files will fetch their own.", err);
    provide("auth0TestToken", null);
  }
}
