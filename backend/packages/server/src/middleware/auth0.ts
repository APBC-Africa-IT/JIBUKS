/**
 * Auth0 JWT verification.
 *
 * Replaces the header-based tenantContext stand-in with real, cryptographically
 * verified identity (constraint C-03). Uses Auth0's own official library,
 * which fetches and caches Auth0's public signing keys automatically -- we
 * never handle key material ourselves.
 *
 * This file ONLY verifies that a token is genuine and reads its `sub` claim.
 * It does NOT yet map that identity to a tenant/user in our database --
 * that mapping happens in a separate piece (userIdentity.ts), since it
 * requires a database lookup and this file should stay focused on
 * cryptographic verification alone.
 */

import { auth } from "express-oauth2-jwt-bearer";

const domain = process.env["AUTH0_DOMAIN"];
const audience = process.env["AUTH0_AUDIENCE"];

if (!domain || !audience) {
  throw new Error("AUTH0_DOMAIN and AUTH0_AUDIENCE must be set");
}

/**
 * Verifies the Authorization: Bearer <token> header on every request it's
 * applied to. On success, attaches the verified token's claims to
 * req.auth.payload (provided by the library) -- including `sub`, the
 * identity we'll map to a real user next.
 *
 * On failure (missing token, invalid signature, expired, wrong audience),
 * automatically responds 401 before the request reaches any route handler.
 */
export const requireAuth0Token = auth({
  issuerBaseURL: `https://${domain}/`,
  audience,
  tokenSigningAlg: "RS256",
});