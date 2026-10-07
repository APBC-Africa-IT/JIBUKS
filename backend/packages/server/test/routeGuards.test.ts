/**
 * Route-guard coverage (FR-RBAC-01): every tenant route must declare a
 * permission guard -- requirePermission(...) or, deliberately,
 * anyAuthenticatedUser. Fails the moment a new endpoint is added without
 * one, rather than relying on review to catch it.
 */

import { describe, expect, it } from "vitest";
import type { Router } from "express";
import { createApp } from "../src/app.js";
import { onboardingRouter } from "../src/modules/onboarding/routes.js";
import { invitesRouter } from "../src/modules/invites/routes.js";
import { hooksRouter } from "../src/modules/payments/routes.js";

interface Layer {
  regexp?: RegExp;
  handle: Router & { guard?: string; stack?: Layer[] };
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
}

/** Routes with no signed-in tenant user, so no role can apply. */
const UNGUARDED: ReadonlyArray<{ router: Router; method: string; path: string }> = [
  { router: onboardingRouter, method: "post", path: "/" },
  { router: onboardingRouter, method: "get", path: "/chart-templates" },
  { router: invitesRouter, method: "get", path: "/:token" },
  { router: invitesRouter, method: "post", path: "/:token/accept" },
  // Safaricom's STK callback: authenticated by the secret in its URL.
  { router: hooksRouter, method: "post", path: "/stk/:tenantId/:paymentId/:token" },
];

function isExempt(router: Router, method: string, path: string): boolean {
  return UNGUARDED.some((e) => e.router === router && e.method === method && e.path === path);
}

/** "/api/v1/cash-sales" from Express 4's mount regexp, for readable failures. */
function mountPath(mount: Layer): string {
  return (mount.regexp?.source ?? "").replace(/^\^/, "").replace(/\\\/\?\(\?=.*$/, "").replace(/\\\//g, "/");
}

describe("route guards", () => {
  it("every route on every module router declares a permission guard", () => {
    const app = createApp() as unknown as { _router: { stack: Layer[] } };
    const unguarded: string[] = [];
    let checked = 0;

    for (const mount of app._router.stack) {
      const subStack = mount.handle.stack;
      if (!subStack || mount.route) {
        continue; // not a mounted module router
      }
      for (const layer of subStack) {
        if (!layer.route) {
          continue;
        }
        for (const method of Object.keys(layer.route.methods)) {
          if (isExempt(mount.handle, method, layer.route.path)) {
            continue;
          }
          checked++;
          const guarded = layer.route.stack.some((l) => typeof l.handle.guard === "string");
          if (!guarded) {
            unguarded.push(`${method.toUpperCase()} ${mountPath(mount)}${layer.route.path}`);
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(40);
    expect(unguarded).toEqual([]);
  });
});
