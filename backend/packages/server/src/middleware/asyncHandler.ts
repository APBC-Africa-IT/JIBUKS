/**
 * Wraps an async route handler so a thrown error (or rejected promise from
 * an awaited call) is forwarded to Express's error-handling chain via
 * next(err), instead of becoming an unhandled rejection.
 *
 * Express 4 does not do this automatically for async functions -- that's
 * fixed in Express 5, but we're on 4 (constraint-free choice here, matching
 * what's stable and widely deployed). Every route handler that uses
 * `await` anywhere in its body MUST be wrapped in this.
 */

import type { NextFunction, Request, Response } from "express";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}