/**
 * Supplier bills routes (FR-AP-02). Separate from the older guided
 * POST /bills, which only posts a journal and keeps working as before.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const supplierBillsRouter: RouterType = Router();

supplierBillsRouter.use(requireRealIdentity);

supplierBillsRouter.post("/", requirePermission("supplier_bills:create"), asyncHandler(controllers.create));
supplierBillsRouter.get("/", requirePermission("supplier_bills:view"), asyncHandler(controllers.list));
supplierBillsRouter.get("/:id", requirePermission("supplier_bills:view"), asyncHandler(controllers.getOne));
supplierBillsRouter.patch("/:id", requirePermission("supplier_bills:create"), asyncHandler(controllers.update));
supplierBillsRouter.delete("/:id", requirePermission("supplier_bills:create"), asyncHandler(controllers.remove));
supplierBillsRouter.post("/:id/post", requirePermission("supplier_bills:post"), asyncHandler(controllers.post));
supplierBillsRouter.post("/:id/cancel", requirePermission("supplier_bills:cancel"), asyncHandler(controllers.cancel));
supplierBillsRouter.post("/:id/payments", requirePermission("supplier_bills:pay"), asyncHandler(controllers.pay));
supplierBillsRouter.post("/:id/debit-notes", requirePermission("supplier_bills:create"), asyncHandler(controllers.createDebitNote));
