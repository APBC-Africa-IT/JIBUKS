/**
 * Opening balances routes (FR-ACC-04).
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const openingBalancesRouter: RouterType = Router();

openingBalancesRouter.use(requireRealIdentity);

openingBalancesRouter.get("/", requirePermission("journals:view"), asyncHandler(controllers.get));
openingBalancesRouter.put("/", requirePermission("opening_balances:manage"), asyncHandler(controllers.put));
