/**
 * Sales receipts routes -- cash sales as numbered documents (CS-000001),
 * the Cash Sale screen and its receipt. Separate from the older guided
 * POST /cash-sales, which only posts a journal and keeps working as before.
 * Same permissions: whoever can record a cash sale can record one here.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const salesReceiptsRouter: RouterType = Router();

salesReceiptsRouter.use(requireRealIdentity);

salesReceiptsRouter.post("/", requirePermission("cash_sales:create"), asyncHandler(controllers.create));
salesReceiptsRouter.get("/", requirePermission("cash_sales:view"), asyncHandler(controllers.list));
salesReceiptsRouter.get("/:id", requirePermission("cash_sales:view"), asyncHandler(controllers.getOne));
