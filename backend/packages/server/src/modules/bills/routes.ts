/**
 * Bills routes. The guided endpoint for Purchases Day Book entries -- see
 * service.ts for what it builds under the hood.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const billsRouter: RouterType = Router();

billsRouter.use(requireRealIdentity);

billsRouter.post("/", requirePermission("bills:create"), asyncHandler(controllers.create));
