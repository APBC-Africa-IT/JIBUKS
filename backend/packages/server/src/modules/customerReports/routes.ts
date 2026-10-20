/**
 * Customer reports routes (/reports/...).
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const customerReportsRouter: RouterType = Router();

customerReportsRouter.use(requireRealIdentity);

customerReportsRouter.get("/customers-to-follow-up", requirePermission("reports:view"), asyncHandler(controllers.customersToFollowUp));
