/**
 * Suppliers routes. Every route requires requireRealIdentity -- there is no
 * suppliers endpoint that operates outside a tenant boundary.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import * as controllers from "./controllers.js";

export const suppliersRouter: RouterType = Router();

suppliersRouter.use(requireRealIdentity);

suppliersRouter.post("/", asyncHandler(controllers.create));
suppliersRouter.get("/", asyncHandler(controllers.list));
suppliersRouter.get("/:id", asyncHandler(controllers.getOne));
suppliersRouter.post("/:id/deactivate", asyncHandler(controllers.deactivate));
suppliersRouter.post("/:id/reactivate", asyncHandler(controllers.reactivate));
