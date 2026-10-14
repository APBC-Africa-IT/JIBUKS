/**
 * Items routes -- the product/service catalogue (Add Item screen and the
 * Item dropdowns). Cashiers and agents can view items to pick them on a
 * cash sale; Owner and Accountant manage the catalogue.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import * as controllers from "./controllers.js";

export const itemsRouter: RouterType = Router();

itemsRouter.use(requireRealIdentity);

itemsRouter.post("/", requirePermission("items:create"), asyncHandler(controllers.create));
itemsRouter.get("/", requirePermission("items:view"), asyncHandler(controllers.list));
itemsRouter.get("/:id", requirePermission("items:view"), asyncHandler(controllers.getOne));
itemsRouter.patch("/:id", requirePermission("items:edit"), asyncHandler(controllers.update));
itemsRouter.post("/:id/deactivate", requirePermission("items:edit"), asyncHandler(controllers.deactivate));
itemsRouter.post("/:id/reactivate", requirePermission("items:edit"), asyncHandler(controllers.reactivate));
