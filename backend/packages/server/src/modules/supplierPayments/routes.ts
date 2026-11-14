/**
 * Supplier payments routes (/supplier-payments). Same permissions as
 * paying a single bill.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const supplierPaymentsRouter: RouterType = Router();

supplierPaymentsRouter.use(requireRealIdentity);

supplierPaymentsRouter.post("/", requirePermission("supplier_bills:pay"), asyncHandler(controllers.create));
supplierPaymentsRouter.get("/", requirePermission("supplier_bills:view"), asyncHandler(controllers.list));
supplierPaymentsRouter.get("/:id", requirePermission("supplier_bills:view"), asyncHandler(controllers.getOne));
