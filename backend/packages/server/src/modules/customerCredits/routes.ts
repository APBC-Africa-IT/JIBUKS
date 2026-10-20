/**
 * Customer refunds routes (/customer-refunds). Available credit is served
 * from customers/routes.ts and apply-credit from invoices/routes.ts.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const customerRefundsRouter: RouterType = Router();

customerRefundsRouter.use(requireRealIdentity);

customerRefundsRouter.post("/", requirePermission("refunds:create"), asyncHandler(controllers.createRefund));
customerRefundsRouter.get("/", requirePermission("payments:view"), asyncHandler(controllers.listRefunds));
customerRefundsRouter.get("/:id", requirePermission("payments:view"), asyncHandler(controllers.getRefund));
