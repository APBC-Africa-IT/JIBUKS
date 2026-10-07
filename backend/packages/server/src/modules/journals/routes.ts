/**
 * Journals routes.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const journalsRouter: RouterType = Router();

journalsRouter.use(requireRealIdentity);

journalsRouter.post("/", requirePermission("journals:create"), asyncHandler(controllers.create));
journalsRouter.get("/", requirePermission("journals:view"), asyncHandler(controllers.list));
journalsRouter.get("/:id", requirePermission("journals:view"), asyncHandler(controllers.getOne));
journalsRouter.post("/:id/reverse", requirePermission("journals:reverse"), asyncHandler(controllers.reverse));
journalsRouter.post("/:id/approve", requirePermission("journals:approve"), asyncHandler(controllers.approve));
journalsRouter.post("/:id/reject", requirePermission("journals:approve"), asyncHandler(controllers.reject));