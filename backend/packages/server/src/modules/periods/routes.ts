/**
 * Periods routes.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const periodsRouter: RouterType = Router();

periodsRouter.use(requireRealIdentity);

periodsRouter.post("/", requirePermission("periods:create"), asyncHandler(controllers.create));
periodsRouter.get("/", requirePermission("periods:view"), asyncHandler(controllers.list));
periodsRouter.get("/:id", requirePermission("periods:view"), asyncHandler(controllers.getOne));
periodsRouter.post("/:id/close", requirePermission("periods:close"), asyncHandler(controllers.close));
periodsRouter.post("/:id/reopen", requirePermission("periods:reopen"), asyncHandler(controllers.reopen));