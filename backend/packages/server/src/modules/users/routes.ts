/**
 * Users routes.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import * as controllers from "./controllers.js";

export const usersRouter: RouterType = Router();

usersRouter.use(requireRealIdentity);

usersRouter.post("/", asyncHandler(controllers.create));
usersRouter.get("/", asyncHandler(controllers.list));
usersRouter.get("/:id", asyncHandler(controllers.getOne));