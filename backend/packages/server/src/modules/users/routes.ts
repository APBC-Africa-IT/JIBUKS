/**
 * Users routes.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { anyAuthenticatedUser, requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const usersRouter: RouterType = Router();

usersRouter.use(requireRealIdentity);

usersRouter.post("/", requirePermission("users:create"), asyncHandler(controllers.create));
usersRouter.get("/", requirePermission("users:view"), asyncHandler(controllers.list));
usersRouter.get("/me", anyAuthenticatedUser, asyncHandler(controllers.me));
usersRouter.get("/:id", requirePermission("users:view"), asyncHandler(controllers.getOne));
usersRouter.get("/:id/roles", requirePermission("users:view"), asyncHandler(controllers.getRoles));
usersRouter.put("/:id/roles", requirePermission("users:edit"), asyncHandler(controllers.setRoles));