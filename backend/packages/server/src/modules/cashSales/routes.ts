/**
 * Cash sales routes. The guided endpoint for Cash Receipts Book entries --
 * see service.ts for what it builds under the hood.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import * as controllers from "./controllers.js";

export const cashSalesRouter: RouterType = Router();

cashSalesRouter.use(requireRealIdentity);

cashSalesRouter.post("/", asyncHandler(controllers.create));
