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
import { invitesRouter } from "./modules/invites/routes.js";
import { onboardingRouter } from "./modules/onboarding/routes.js";
import { usersRouter } from "./modules/users/routes.js";
import { accountsRouter } from "./modules/accounts/routes.js";
import { customersRouter } from "./modules/customers/routes.js";
import { suppliersRouter } from "./modules/suppliers/routes.js";
import { periodsRouter } from "./modules/periods/routes.js";
import { journalsRouter } from "./modules/journals/routes.js";
import { creditSalesRouter } from "./modules/creditSales/routes.js";
import { cashSalesRouter } from "./modules/cashSales/routes.js";
import { billsRouter } from "./modules/bills/routes.js";
import { requireAuth0Token } from "./middleware/auth0.js";

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const openapiDocument = YAML.load(path.join(__dirname, "../../../openapi/openapi.yaml"));
  app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

  // Raw spec, for tooling (e.g. the frontend team's OpenAPI code generators)
  // that needs to fetch the actual YAML file, not just view it via Swagger UI.
  app.get("/api/v1/openapi.yaml", (_req, res) => {
    res.type("text/yaml").sendFile(path.join(__dirname, "../../../openapi/openapi.yaml"));
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  // TEMPORARY debug route -- proves Auth0 verification works before we
  // wire real identity mapping into any module. Remove once userIdentity.ts
  // exists and real modules use it instead.
  app.get("/_debug/verified", requireAuth0Token, (req, res) => {
    res.json({ claims: req.auth?.payload });
  });

  // Section 9.1: all endpoints are under /api/v1.
  app.use("/api/v1/onboarding", onboardingRouter);
  app.use("/api/v1/invites", invitesRouter);
  app.use("/api/v1/users", usersRouter);
  app.use("/api/v1/accounts", accountsRouter);
  app.use("/api/v1/customers", customersRouter);
  app.use("/api/v1/suppliers", suppliersRouter);
  app.use("/api/v1/periods", periodsRouter);
  app.use("/api/v1/journals", journalsRouter);
  app.use("/api/v1/credit-sales", creditSalesRouter);
  app.use("/api/v1/cash-sales", cashSalesRouter);
  app.use("/api/v1/bills", billsRouter);

  // Error handler must be registered LAST -- Express identifies it by its
  // four-parameter arity and only routes errors to middleware registered
  // after the point where they were thrown.
  app.use(errorHandler);

  return app;
}