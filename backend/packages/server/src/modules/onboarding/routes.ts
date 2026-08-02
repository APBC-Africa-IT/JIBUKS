/**
 * Onboarding routes. Public relative to the rest of the API in the sense
 * that no pre-existing app user is required -- but a genuine, verified
 * Auth0 token IS required, so this is not reachable by an unauthenticated
 * caller with no Auth0 account at all.
 */

import { Router, type Router as RouterType } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireAuth0Token } from "../../middleware/auth0.js";
import * as controllers from "./controllers.js";

export const onboardingRouter: RouterType = Router();

onboardingRouter.use(requireAuth0Token);

onboardingRouter.post("/", asyncHandler(controllers.create));