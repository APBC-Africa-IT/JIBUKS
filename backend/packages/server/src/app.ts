/**
 * Express application assembly.
 *
 * Deliberately separate from server.ts: this file builds and configures the
 * app (middleware, routes) but never calls .listen(). That lets tests import
 * `app` and exercise it in-memory (via supertest, later) without binding a
 * real network port -- and lets server.ts stay a one-line entrypoint.
 */

import express, { type Express } from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { errorHandler } from "./middleware/errorHandler.js";
import { accountsRouter } from "./modules/accounts/routes.js";
import { periodsRouter } from "./modules/periods/routes.js";
import { journalsRouter } from "./modules/journals/routes.js";

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const openapiDocument = YAML.load(path.join(__dirname, "../../../openapi/openapi.yaml"));
  app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Section 9.1: all endpoints are under /api/v1.
  app.use("/api/v1/accounts", accountsRouter);
  app.use("/api/v1/periods", periodsRouter);
  app.use("/api/v1/journals", journalsRouter);

  // Error handler must be registered LAST -- Express identifies it by its
  // four-parameter arity and only routes errors to middleware registered
  // after the point where they were thrown.
  app.use(errorHandler);

  return app;
}