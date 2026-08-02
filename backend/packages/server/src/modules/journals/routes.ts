/**
 * Journals routes.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import * as controllers from "./controllers.js";

export const journalsRouter: RouterType = Router();

journalsRouter.use(requireRealIdentity);

journalsRouter.post("/", asyncHandler(controllers.create));
journalsRouter.get("/", asyncHandler(controllers.list));
journalsRouter.get("/:id", asyncHandler(controllers.getOne));
journalsRouter.post("/:id/reverse", asyncHandler(controllers.reverse));