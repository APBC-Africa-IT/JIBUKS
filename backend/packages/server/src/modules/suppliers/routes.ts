/**
 * Suppliers routes. Every route requires requireRealIdentity -- there is no
 * suppliers endpoint that operates outside a tenant boundary.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const suppliersRouter: RouterType = Router();

suppliersRouter.use(requireRealIdentity);

suppliersRouter.post("/", requirePermission("suppliers:create"), asyncHandler(controllers.create));
suppliersRouter.get("/", requirePermission("suppliers:view"), asyncHandler(controllers.list));
suppliersRouter.get("/:id", requirePermission("suppliers:view"), asyncHandler(controllers.getOne));
suppliersRouter.patch("/:id", requirePermission("suppliers:edit"), asyncHandler(controllers.update));
suppliersRouter.post("/:id/deactivate", requirePermission("suppliers:edit"), asyncHandler(controllers.deactivate));
suppliersRouter.post("/:id/reactivate", requirePermission("suppliers:edit"), asyncHandler(controllers.reactivate));
