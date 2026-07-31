/**
 * Express application assembly.
 *
 * Deliberately separate from server.ts: this file builds and configures the
 * app (middleware, routes) but never calls .listen(). That lets tests import
 * `app` and exercise it in-memory (via supertest, later) without binding a
 * real network port -- and lets server.ts stay a one-line entrypoint.
 */

import express, { type Express } from "express";
import { errorHandler } from "./middleware/errorHandler.js";
import { accountsRouter } from "./modules/accounts/routes.js";

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Section 9.1: all endpoints are under /api/v1.
  app.use("/api/v1/accounts", accountsRouter);

  // Error handler must be registered LAST -- Express identifies it by its
  // four-parameter arity and only routes errors to middleware registered
  // after the point where they were thrown.
  app.use(errorHandler);

  return app;
}