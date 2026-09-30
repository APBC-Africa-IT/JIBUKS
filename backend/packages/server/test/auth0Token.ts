/**
 * Fetches a real Auth0 token via the client-credentials flow, as the
 * Auth0 M2M test application. Shared by globalSetup.ts (one fetch for the
 * whole run) and testAuth.ts (fallback when that wasn't available).
 */

export async function fetchAuth0TestToken(): Promise<string> {
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
  return body.access_token;
}
