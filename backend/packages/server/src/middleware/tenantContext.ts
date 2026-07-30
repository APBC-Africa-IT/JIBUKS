/**
 * Tenant context resolution.
 *
 * TEMPORARY: reads the tenant from an X-Tenant-Id header. This is a
 * development-only stand-in -- a header is client-supplied and trivially
 * spoofable, letting any caller claim to be any tenant. It exists purely so
 * modules can be built and tested against a real tenant boundary before
 * identity/auth exists.
 *
 * MUST be replaced before any real deployment: the real version extracts
 * tenant_id from a validated JWT claim (constraint C-03), never a header a
 * client can set directly. When that lands, this file is what gets swapped
 * -- nothing downstream (services, repositories) should need to change,
 * since they only ever consume req.tenantId, not the header itself.
 */

import type { NextFunction, Request, Response } from "express";
import { isUuid } from "@jibuks/domain";

export function tenantContext(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("X-Tenant-Id");

  if (!header) {
    res.status(400).type("application/problem+json").json({
      type: "tag:jibuks,2026:error/TENANT_HEADER_MISSING",
      title: "TENANT_HEADER_MISSING",
      status: 400,
      detail: "X-Tenant-Id header is required (temporary stand-in until identity/auth is built)",
    });
    return;
  }

  if (!isUuid(header)) {
    res.status(400).type("application/problem+json").json({
      type: "tag:jibuks,2026:error/TENANT_HEADER_INVALID",
      title: "TENANT_HEADER_INVALID",
      status: 400,
      detail: "X-Tenant-Id must be a valid UUID",
    });
    return;
  }

  req.tenantId = header;
  next();
}