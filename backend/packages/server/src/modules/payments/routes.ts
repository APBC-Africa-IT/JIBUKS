/**
 * Payments routes.
 *
 * Two routers with different auth postures:
 *   paymentsRouter  -> /api/v1/payments, signed-in tenant users
 *   hooksRouter     -> /api/v1/hooks, called by Safaricom with NO auth
 *                      header; each payment's callback URL carries its own
 *                      secret instead (see service.ts)
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const paymentsRouter: RouterType = Router();

paymentsRouter.use(requireRealIdentity);

paymentsRouter.post("/mpesa/stk-push", requirePermission("payments:create"), asyncHandler(controllers.stkPush));
paymentsRouter.get("/", requirePermission("payments:view"), asyncHandler(controllers.list));
paymentsRouter.get("/:id", requirePermission("payments:view"), asyncHandler(controllers.getOne));
paymentsRouter.post("/:id/repost", requirePermission("payments:create"), asyncHandler(controllers.repost));

export const hooksRouter: RouterType = Router();

hooksRouter.post("/stk/:tenantId/:paymentId/:token", asyncHandler(controllers.stkCallback));
