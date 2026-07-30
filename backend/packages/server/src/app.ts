/**
 * Express application assembly.
 *
 * Deliberately separate from server.ts: this file builds and configures the
 * app (middleware, routes) but never calls .listen(). That lets tests import
 * `app` and exercise it in-memory (via supertest, later) without binding a
 * real network port -- and lets server.ts stay a one-line entrypoint.
 */

import express, { type Express } from "express";

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  // Bare health check -- proves the process is up and answering HTTP at
  // all, before any module, database, or auth logic is involved.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}