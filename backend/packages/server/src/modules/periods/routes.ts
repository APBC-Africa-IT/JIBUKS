/**
 * Periods routes.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import * as controllers from "./controllers.js";

export const periodsRouter: RouterType = Router();

periodsRouter.use(requireRealIdentity);

periodsRouter.post("/", asyncHandler(controllers.create));
periodsRouter.get("/", asyncHandler(controllers.list));
periodsRouter.get("/:id", asyncHandler(controllers.getOne));
periodsRouter.post("/:id/close", asyncHandler(controllers.close));
periodsRouter.post("/:id/reopen", asyncHandler(controllers.reopen));