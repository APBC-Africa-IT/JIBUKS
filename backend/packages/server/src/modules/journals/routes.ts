/**
 * Journals routes.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { tenantContext } from "../../middleware/tenantContext.js";
import * as controllers from "./controllers.js";

export const journalsRouter: RouterType = Router();

journalsRouter.use(tenantContext);

journalsRouter.post("/", asyncHandler(controllers.create));
journalsRouter.get("/", asyncHandler(controllers.list));
journalsRouter.get("/:id", asyncHandler(controllers.getOne));
journalsRouter.post("/:id/reverse", asyncHandler(controllers.reverse));