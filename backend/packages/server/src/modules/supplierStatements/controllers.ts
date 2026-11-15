/**
 * Supplier statement controllers -- HTTP layer only. Served at
 * GET /suppliers/{id}/statement and /statement/pdf (suppliers/routes.ts).
 */

import type { Request, Response } from "express";
import { supplierStatementQuerySchema } from "@jibuks/domain";
import * as service from "./service.js";

export async function statement(req: Request, res: Response): Promise<void> {
  const { from, to } = supplierStatementQuerySchema.parse(req.query);
  res.json(await service.getStatement({ tenantId: req.tenantId!, supplierId: req.params["id"]!, from, to }));
}

/** inline: the app can show it or hand it to the phone's share sheet. */
export async function pdf(req: Request, res: Response): Promise<void> {
  const { from, to } = supplierStatementQuerySchema.parse(req.query);
  const { filename, pdf: body } = await service.getStatementPdf({ tenantId: req.tenantId!, supplierId: req.params["id"]!, from, to });
  res
    .status(200)
    .type("application/pdf")
    .set("Content-Disposition", `inline; filename="${filename}"`)
    .set("Cache-Control", "private, no-store")
    .send(body);
}
