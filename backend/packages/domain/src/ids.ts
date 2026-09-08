/**
 * Identity of records.
 *
 * SRS Section 3.3.2: "Every locally created record is assigned a
 * client-generated UUID at creation. The server accepts that UUID as the
 * record identity. Identity is therefore never reassigned on synchronisation."
 * DR-05 requires client UUIDs be accepted and be unique per tenant.
 */

import { randomUUID } from "node:crypto";

export type Uuid = string;
export type TenantId = Uuid;
export type UserId = Uuid;
export type AccountId = Uuid;
export type JournalId = Uuid;
export type BranchId = Uuid;
export type PeriodId = Uuid;
export type CustomerId = Uuid;
export type SupplierId = Uuid;
export type DeviceId = string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is Uuid {
  return typeof value === "string" && UUID_RE.test(value);
}

export function newUuid(): Uuid {
  return randomUUID();
}

/**
 * Idempotency key for a sync operation.
 * SRS Section 3.3.2: "an idempotency key derived from the client UUID and the
 * operation. A repeated request MUST return the result of the original
 * operation rather than creating a duplicate." Also C-08, FR-PAY-06.
 */
export function idempotencyKey(clientUuid: Uuid, operation: string): string {
  return `${operation}:${clientUuid}`;
}