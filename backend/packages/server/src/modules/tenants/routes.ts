/**
 * Tenant routes. GET /tenant is the caller's own business -- every signed-in
 * user may read it, since the app needs it to decide what to show. Changing
 * it (PATCH) is for the Owner (tenant:edit).
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { anyAuthenticatedUser, requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const tenantRouter: RouterType = Router();

tenantRouter.use(requireRealIdentity);

tenantRouter.get("/", anyAuthenticatedUser, asyncHandler(controllers.get));
tenantRouter.patch("/", requirePermission("tenant:edit"), asyncHandler(controllers.update));
