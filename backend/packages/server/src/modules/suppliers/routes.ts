/**
 * Suppliers routes. Every route requires requireRealIdentity -- there is no
 * suppliers endpoint that operates outside a tenant boundary.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as ledgerControllers from "../supplierLedger/controllers.js";
import * as controllers from "./controllers.js";

export const suppliersRouter: RouterType = Router();

suppliersRouter.use(requireRealIdentity);

suppliersRouter.post("/", requirePermission("suppliers:create"), asyncHandler(controllers.create));
// List and detail carry each supplier's last activity and payment status, which the supplier ledger works out.
suppliersRouter.get("/", requirePermission("suppliers:view"), asyncHandler(ledgerControllers.list));
suppliersRouter.get("/:id", requirePermission("suppliers:view"), asyncHandler(ledgerControllers.getOne));
suppliersRouter.get("/:id/transactions", requirePermission("suppliers:view"), asyncHandler(ledgerControllers.transactions));
suppliersRouter.patch("/:id", requirePermission("suppliers:edit"), asyncHandler(controllers.update));
suppliersRouter.post("/:id/deactivate", requirePermission("suppliers:edit"), asyncHandler(controllers.deactivate));
suppliersRouter.post("/:id/reactivate", requirePermission("suppliers:edit"), asyncHandler(controllers.reactivate));

/** Each business's Supplier Type list (/supplier-types): the dropdown and its "+ Add type". */
export const supplierTypesRouter: RouterType = Router();

supplierTypesRouter.use(requireRealIdentity);

supplierTypesRouter.get("/", requirePermission("suppliers:view"), asyncHandler(controllers.listTypes));
supplierTypesRouter.post("/", requirePermission("suppliers:create"), asyncHandler(controllers.createType));
supplierTypesRouter.patch("/:id", requirePermission("suppliers:edit"), asyncHandler(controllers.renameType));
