/**
 * The Suppliers hub's Overview tab (/payables-overview). Same permission as
 * payables aging, whose totals it shares.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const payablesOverviewRouter: RouterType = Router();

payablesOverviewRouter.use(requireRealIdentity);

payablesOverviewRouter.get("/", requirePermission("reports:view"), asyncHandler(controllers.overview));
