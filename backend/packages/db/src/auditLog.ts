/**
 * Audit log recording helper.
 *
 * FR-AUD-01 requires every create/update/delete/approve/export/privileged-read
 * against financial data to be captured. This helper is the ONE place that
 * writes to audit_logs, so every module's repository calls the same function
 * rather than reimplementing the insert.
 *
 * MUST be called from inside the SAME transaction (the same withTenant
 * callback, using the same `client`) as the actual data-changing write it is
 * recording. That is what makes the log and the change atomic: if either the
 * write or its audit entry fails, withTenant rolls back both together.
 */

import type { PoolClient } from "pg";

export type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "APPROVE" | "EXPORT" | "READ";

export interface AuditContext {
  readonly actorUserId: string;
  readonly ipAddress?: string;
  readonly deviceId?: string;
}

export interface RecordAuditLogInput {
  readonly tenantId: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly beforeState?: unknown;
  readonly afterState?: unknown;
  readonly context: AuditContext;
}

export async function recordAuditLog(client: PoolClient, input: RecordAuditLogInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
       (tenant_id, actor_user_id, action, entity_type, entity_id, before_state, after_state, ip_address, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.tenantId,
      input.context.actorUserId,
      input.action,
      input.entityType,
      input.entityId,
      input.beforeState !== undefined ? JSON.stringify(input.beforeState) : null,
      input.afterState !== undefined ? JSON.stringify(input.afterState) : null,
      input.context.ipAddress ?? null,
      input.context.deviceId ?? null,
    ],
  );
}