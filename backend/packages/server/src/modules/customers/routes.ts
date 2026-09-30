/**
 * Customers routes. Every route requires requireRealIdentity -- there is no
 * customers endpoint that operates outside a tenant boundary.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const customersRouter: RouterType = Router();

customersRouter.use(requireRealIdentity);

customersRouter.post("/", requirePermission("customers:create"), asyncHandler(controllers.create));
customersRouter.get("/", requirePermission("customers:view"), asyncHandler(controllers.list));
customersRouter.get("/:id", requirePermission("customers:view"), asyncHandler(controllers.getOne));
customersRouter.post("/:id/deactivate", requirePermission("customers:edit"), asyncHandler(controllers.deactivate));
customersRouter.post("/:id/reactivate", requirePermission("customers:edit"), asyncHandler(controllers.reactivate));
