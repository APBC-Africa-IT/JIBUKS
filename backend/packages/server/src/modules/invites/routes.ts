/**
 * Invites routes.
 *
 * Three distinct auth postures in one module -- read this before adding
 * any new route here:
 *   POST /            -> requireRealIdentity (existing tenant user invites someone)
 *   GET  /             -> requireRealIdentity (list your tenant's invites)
 *   GET  /:token        -> NO auth middleware at all (invitee hasn't logged in yet)
 *   POST /:token/accept -> requireAuth0Token ONLY, same tier as onboarding
 *                          (genuine token required, but no existing platform
 *                          user -- that's what this endpoint creates)
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRealIdentity } from "../../middleware/authContext.js";
import { requireAuth0Token } from "../../middleware/auth0.js";
import * as controllers from "./controllers.js";

export const invitesRouter: RouterType = Router();

invitesRouter.post("/", requireRealIdentity, asyncHandler(controllers.create));
invitesRouter.get("/", requireRealIdentity, asyncHandler(controllers.list));

// Deliberately BEFORE any auth middleware -- public, matches the file
// header. Preview must never require login, since its whole purpose is
// showing who invited you before you've logged in at all.
invitesRouter.get("/:token", asyncHandler(controllers.preview));

invitesRouter.post("/:token/accept", requireAuth0Token, asyncHandler(controllers.accept));
