/**
 * Tenant routes. GET /tenant is the caller's own business -- every signed-in
 * user may read it, since the app needs it to decide what to show.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { anyAuthenticatedUser } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const tenantRouter: RouterType = Router();

tenantRouter.use(requireRealIdentity);

tenantRouter.get("/", anyAuthenticatedUser, asyncHandler(controllers.get));
