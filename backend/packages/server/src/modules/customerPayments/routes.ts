/**
 * Customer payments routes (/customer-payments). Same permissions as
 * taking a payment against an invoice.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const customerPaymentsRouter: RouterType = Router();

customerPaymentsRouter.use(requireRealIdentity);

customerPaymentsRouter.post("/", requirePermission("payments:create"), asyncHandler(controllers.create));
customerPaymentsRouter.get("/", requirePermission("payments:view"), asyncHandler(controllers.list));
customerPaymentsRouter.get("/:id", requirePermission("payments:view"), asyncHandler(controllers.getOne));
