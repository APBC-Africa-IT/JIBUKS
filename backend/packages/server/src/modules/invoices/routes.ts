/**
 * Invoices routes (FR-AR-02/05, Section 9.2). Recording a payment uses
 * payments:create -- the same permission as collecting by M-Pesa -- so a
 * Cashier can take payment against an invoice without being able to raise one.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const invoicesRouter: RouterType = Router();

invoicesRouter.use(requireRealIdentity);

invoicesRouter.post("/", requirePermission("invoices:create"), asyncHandler(controllers.create));
invoicesRouter.get("/", requirePermission("invoices:view"), asyncHandler(controllers.list));
invoicesRouter.get("/:id", requirePermission("invoices:view"), asyncHandler(controllers.getOne));
invoicesRouter.patch("/:id", requirePermission("invoices:create"), asyncHandler(controllers.update));
invoicesRouter.delete("/:id", requirePermission("invoices:create"), asyncHandler(controllers.remove));
invoicesRouter.post("/:id/issue", requirePermission("invoices:issue"), asyncHandler(controllers.issue));
invoicesRouter.post("/:id/cancel", requirePermission("invoices:cancel"), asyncHandler(controllers.cancel));
invoicesRouter.post("/:id/payments", requirePermission("payments:create"), asyncHandler(controllers.recordPayment));
invoicesRouter.post("/:id/credit-notes", requirePermission("invoices:create"), asyncHandler(controllers.createCreditNote));
invoicesRouter.post("/:id/convert", requirePermission("invoices:create"), asyncHandler(controllers.convert));
