/**
 * Credit sales routes. The guided endpoint for FR-ACC-01-style Sales Day
 * Book entries -- see service.ts for what it builds under the hood.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import * as controllers from "./controllers.js";

export const creditSalesRouter: RouterType = Router();

creditSalesRouter.use(requireRealIdentity);

creditSalesRouter.post("/", asyncHandler(controllers.create));
