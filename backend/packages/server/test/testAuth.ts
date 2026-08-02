/**
 * Shared test helper for authenticated requests.
 *
 * Fetches ONE real Auth0 token via the client-credentials flow, cached for
 * the whole test run -- avoids either faking token signing ourselves (which
 * would mean maintaining a second, parallel implementation of what
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

export const TEST_TENANT_ID = "99999999-0000-4000-8000-000000000001";
export const TEST_USER_ID = "99999999-0000-4000-8000-000000000002";

let cachedToken: string | undefined;

export async function getTestToken(): Promise<string> {
  if (cachedToken) {
    return cachedToken;
  }

  const domain = process.env["AUTH0_DOMAIN"];
  const clientId = process.env["AUTH0_TEST_CLIENT_ID"];
  const clientSecret = process.env["AUTH0_TEST_CLIENT_SECRET"];
  const audience = process.env["AUTH0_AUDIENCE"];

  if (!domain || !clientId || !clientSecret || !audience) {
    throw new Error(
      "AUTH0_DOMAIN, AUTH0_TEST_CLIENT_ID, AUTH0_TEST_CLIENT_SECRET, AUTH0_AUDIENCE must all be set to run authenticated tests",
    );
  }

  const response = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience,
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch test token from Auth0: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { access_token: string };
  cachedToken = body.access_token;
  return cachedToken;
}

/** Convenience: the Authorization header value, ready to pass to .set(). */
export async function authHeader(): Promise<string> {
  return `Bearer ${await getTestToken()}`;
}