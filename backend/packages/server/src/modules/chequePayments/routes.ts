/**
 * Cheque payments routes -- cheques as numbered documents (CHQ-000001), the
 * Write Cheque screen. Separate from the older guided POST /cheques, which
 * only posts a journal and keeps working as before. Same permission to write.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const chequePaymentsRouter: RouterType = Router();

chequePaymentsRouter.use(requireRealIdentity);

chequePaymentsRouter.post("/", requirePermission("cheques:create"), asyncHandler(controllers.create));
chequePaymentsRouter.get("/", requirePermission("cheques:view"), asyncHandler(controllers.list));
chequePaymentsRouter.get("/:id", requirePermission("cheques:view"), asyncHandler(controllers.getOne));
