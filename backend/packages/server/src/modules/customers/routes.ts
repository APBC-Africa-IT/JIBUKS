/**
 * Customers routes. Every route requires requireRealIdentity -- there is no
 * customers endpoint that operates outside a tenant boundary.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import * as controllers from "./controllers.js";

export const customersRouter: RouterType = Router();

customersRouter.use(requireRealIdentity);

customersRouter.post("/", asyncHandler(controllers.create));
customersRouter.get("/", asyncHandler(controllers.list));
customersRouter.get("/:id", asyncHandler(controllers.getOne));
customersRouter.post("/:id/deactivate", asyncHandler(controllers.deactivate));
customersRouter.post("/:id/reactivate", asyncHandler(controllers.reactivate));
