/**
 
 * Accounts routes. Every route requires requireRealIdentity -- there is no
 * accounts endpoint that operates outside a tenant boundary.
 */


import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const accountsRouter: RouterType = Router();

accountsRouter.use(requireRealIdentity);

accountsRouter.post("/", requirePermission("accounts:create"), asyncHandler(controllers.create));
accountsRouter.get("/", requirePermission("accounts:view"), asyncHandler(controllers.list));
accountsRouter.get("/:id", requirePermission("accounts:view"), asyncHandler(controllers.getOne));
accountsRouter.patch("/:id", requirePermission("accounts:edit"), asyncHandler(controllers.update));
accountsRouter.post("/:id/deactivate", requirePermission("accounts:edit"), asyncHandler(controllers.deactivate));
accountsRouter.post("/:id/reactivate", requirePermission("accounts:edit"), asyncHandler(controllers.reactivate));