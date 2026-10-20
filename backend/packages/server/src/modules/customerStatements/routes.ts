/**
 * Customer statements routes (/customer-statements).
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const customerStatementsRouter: RouterType = Router();

customerStatementsRouter.use(requireRealIdentity);

customerStatementsRouter.post("/", requirePermission("statements:create"), asyncHandler(controllers.create));
customerStatementsRouter.get("/", requirePermission("statements:view"), asyncHandler(controllers.list));
customerStatementsRouter.get("/:id", requirePermission("statements:view"), asyncHandler(controllers.getOne));
customerStatementsRouter.get("/:id/pdf", requirePermission("statements:view"), asyncHandler(controllers.pdf));
customerStatementsRouter.post("/:id/mark-sent", requirePermission("statements:create"), asyncHandler(controllers.markSent));
