/**
 * Cash purchases routes (/cash-purchases). Cashiers may record and see
 * them, as they do cash sales and cash expenses.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const cashPurchasesRouter: RouterType = Router();

cashPurchasesRouter.use(requireRealIdentity);

cashPurchasesRouter.post("/", requirePermission("cash_purchases:create"), asyncHandler(controllers.create));
cashPurchasesRouter.get("/", requirePermission("cash_purchases:view"), asyncHandler(controllers.list));
cashPurchasesRouter.get("/:id", requirePermission("cash_purchases:view"), asyncHandler(controllers.getOne));
