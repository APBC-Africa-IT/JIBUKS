/**
 * Supplier refunds routes (/supplier-refunds). Available credit is served
 * from suppliers/routes.ts and apply-credit from supplierBills/routes.ts.
 * Same permissions as paying bills: money in from a supplier is handled by
 * whoever handles money out to them.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const supplierRefundsRouter: RouterType = Router();

supplierRefundsRouter.use(requireRealIdentity);

supplierRefundsRouter.post("/", requirePermission("supplier_bills:pay"), asyncHandler(controllers.createRefund));
supplierRefundsRouter.get("/", requirePermission("supplier_bills:view"), asyncHandler(controllers.listRefunds));
supplierRefundsRouter.get("/:id", requirePermission("supplier_bills:view"), asyncHandler(controllers.getRefund));
