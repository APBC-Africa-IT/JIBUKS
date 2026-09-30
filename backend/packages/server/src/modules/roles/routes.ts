/**
 * Roles routes (FR-RBAC-01/02). Built-in roles are listed alongside the
 * tenant's custom roles but can't be changed -- see service.ts.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const rolesRouter: RouterType = Router();

rolesRouter.use(requireRealIdentity);

// Before /:id, so "permissions" isn't read as a role id.
rolesRouter.get("/permissions", requirePermission("roles:view"), asyncHandler(controllers.listPermissions));
rolesRouter.get("/", requirePermission("roles:view"), asyncHandler(controllers.list));
rolesRouter.post("/", requirePermission("roles:create"), asyncHandler(controllers.create));
rolesRouter.get("/:id", requirePermission("roles:view"), asyncHandler(controllers.getOne));
rolesRouter.patch("/:id", requirePermission("roles:edit"), asyncHandler(controllers.update));
rolesRouter.post("/:id/deactivate", requirePermission("roles:edit"), asyncHandler(controllers.deactivate));
rolesRouter.post("/:id/reactivate", requirePermission("roles:edit"), asyncHandler(controllers.reactivate));
