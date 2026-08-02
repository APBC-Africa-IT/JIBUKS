/**
 * Accounts routes. Every route requires tenantContext -- there is no
 * accounts endpoint that operates outside a tenant boundary.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import * as controllers from "./controllers.js";

export const accountsRouter: RouterType = Router();

accountsRouter.use(requireRealIdentity);

accountsRouter.post("/", asyncHandler(controllers.create));
accountsRouter.get("/", asyncHandler(controllers.list));
accountsRouter.get("/:id", asyncHandler(controllers.getOne));
accountsRouter.post("/:id/deactivate", asyncHandler(controllers.deactivate));
accountsRouter.post("/:id/reactivate", asyncHandler(controllers.reactivate));