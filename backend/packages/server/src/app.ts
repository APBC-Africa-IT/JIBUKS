/**
 * Express application assembly.
 *
 * Deliberately separate from server.ts: this file builds and configures the
 * app (middleware, routes) but never calls .listen(). That lets tests import
 * `app` and exercise it in-memory (via supertest, later) without binding a
 * real network port -- and lets server.ts stay a one-line entrypoint.
 */

import express, { type Express } from "express";
import { DomainError } from "@jibuks/domain";
import { asyncHandler } from "./middleware/asyncHandler.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { tenantContext } from "./middleware/tenantContext.js";

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  // Bare health check -- no tenant context needed, proves the process is
  // up before any module, database, or auth logic is involved.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ---------------------------------------------------------------------
  // TEMPORARY proof-of-wiring route. Deliberately not a real module -- it
  // exists only to demonstrate the full middleware chain (tenant context ->
  // async handler -> thrown DomainError -> error handler) before we build
  // the first actual module. Remove once the accounts module lands.
  // ---------------------------------------------------------------------
  app.get(
    "/_debug/whoami",
    tenantContext,
    asyncHandler(async (req, res) => {
      res.json({ tenantId: req.tenantId });
    }),
  );

  app.get(
    "/_debug/boom",
    tenantContext,
    asyncHandler(async () => {
      throw new DomainError("ACCOUNT_NOT_FOUND", "This is a deliberate test error");
    }),
  );

  // Error handler must be registered LAST -- Express identifies it by its
  // four-parameter arity and only routes errors to middleware registered
  // after the point where they were thrown.
  app.use(errorHandler);

  return app;
}