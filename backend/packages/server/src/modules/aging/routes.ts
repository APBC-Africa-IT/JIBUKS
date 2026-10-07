/**
 * Aging routes (FR-AR-04, FR-AP-03). Read-only.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const receivablesAgingRouter: RouterType = Router();
receivablesAgingRouter.use(requireRealIdentity);
receivablesAgingRouter.get("/", requirePermission("reports:view"), asyncHandler(controllers.receivables));

export const payablesAgingRouter: RouterType = Router();
payablesAgingRouter.use(requireRealIdentity);
payablesAgingRouter.get("/", requirePermission("reports:view"), asyncHandler(controllers.payables));
