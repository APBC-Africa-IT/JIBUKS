/**
 * Cheques routes. The guided endpoint for Cash Payments Book entries --
 * see service.ts for what it builds under the hood.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import * as controllers from "./controllers.js";

export const chequesRouter: RouterType = Router();

chequesRouter.use(requireRealIdentity);

chequesRouter.post("/", asyncHandler(controllers.create));
