/**
 * Idempotency-Key header support.
 *
 * SRS Section 9.1 (Idempotency): "All POST, PUT and PATCH endpoints accept
 * an Idempotency-Key header. Endpoints reachable from an offline client
 * require it. A repeat with the same key returns the original result and
 * does not re-execute." Also C-08 and Section 3.3.2.
 *
 * Behaviour, per (tenant, key):
 *   - first request: claimed, handler runs normally
 *   - 2xx outcome: response stored; repeats replay it verbatim with an
 *     `Idempotent-Replayed: true` header, without re-running the handler
 *   - non-2xx outcome: claim released -- the handler's transaction rolled
 *     back, so nothing executed and the client may retry under the same key
 *   - same key, different user/method/path/body: 422 IDEMPOTENCY_KEY_REUSED
 *     (the user is part of the match, so one user can never be handed
 *     another user's stored response -- replays run before route
 *     permission guards)
 *   - same key while the original is still running: 409
 *     IDEMPOTENCY_REQUEST_IN_PROGRESS
 *
 * The header is currently OPTIONAL everywhere. Without it, requests behave
 * exactly as before (a repeated clientUuid still gets 409 DUPLICATE_VALUE).
 *
 * Keys are tenant-scoped, so this runs after identity resolution (see
 * authContext.ts). Requests from a user with no tenant yet pass through.
 */

import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { DomainError } from "@jibuks/domain";
import * as repository from "../modules/idempotency/repository.js";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH"]);

// Printable ASCII, no whitespace -- comfortably fits UUIDs and the
// `operation:clientUuid` shape produced by @jibuks/domain's idempotencyKey().
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** JSON with object keys sorted, so semantically equal bodies hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestHash(req: Request): string {
  return createHash("sha256")
    .update(`${req.actorUserId ?? ""}\n${req.method}\n${req.originalUrl}\n${canonicalJson(req.body ?? null)}`)
    .digest("hex");
}

async function handleIdempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.get(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || !MUTATING_METHODS.has(req.method) || !req.tenantId) {
    next();
    return;
  }

  if (!KEY_RE.test(key)) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key must be 1-255 printable ASCII characters with no spaces",
    );
  }

  const tenantId = req.tenantId;
  const hash = requestHash(req);
  const result = await repository.claim(tenantId, key, hash);

  if (!result.claimed) {
    const { existing } = result;
    if (existing.status === "IN_PROGRESS") {
      throw new DomainError(
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        "A request with this Idempotency-Key is still being processed; retry shortly",
      );
    }
    if (existing.request_hash !== hash) {
      throw new DomainError(
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used for a different request",
      );
    }
    res
      .status(existing.response_status ?? 200)
      .set(IDEMPOTENT_REPLAYED_HEADER, "true")
      .json(existing.response_body);
    return;
  }

  // Every response in this app -- success or error (errorHandler) -- goes
  // out through res.json, so intercepting it catches every outcome. The
  // result is persisted BEFORE the response is sent, so a client that has
  // seen a 2xx is guaranteed its retry will replay rather than re-execute.
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const status = res.statusCode;
    const settle =
      status >= 200 && status < 300
        ? repository.complete(tenantId, key, status, body)
        : repository.release(tenantId, key);
    settle
      .catch((err: unknown) => {
        // Never fail the client's request over bookkeeping. A claim left
        // IN_PROGRESS goes stale and can be taken over (see repository.ts).
        console.error("Failed to settle idempotency key:", err);
      })
      .finally(() => {
        originalJson(body);
      });
    return res;
  }) as Response["json"];

  next();
}

export function idempotency(req: Request, res: Response, next: NextFunction): void {
  handleIdempotency(req, res, next).catch(next);
}
