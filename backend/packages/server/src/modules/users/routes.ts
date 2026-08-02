/**
 * Users routes.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { tenantContext } from "../../middleware/tenantContext.js";
import * as controllers from "./controllers.js";

export const usersRouter: RouterType = Router();

usersRouter.use(tenantContext);

usersRouter.post("/", asyncHandler(controllers.create));
usersRouter.get("/", asyncHandler(controllers.list));
usersRouter.get("/:id", asyncHandler(controllers.getOne));