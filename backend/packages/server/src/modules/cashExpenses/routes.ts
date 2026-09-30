/**
 * Cash expenses routes. The guided endpoint for Cash Payments Book
 * expense entries -- see service.ts for what it builds under the hood.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const cashExpensesRouter: RouterType = Router();

cashExpensesRouter.use(requireRealIdentity);

cashExpensesRouter.post("/", requirePermission("cash_expenses:create"), asyncHandler(controllers.create));
