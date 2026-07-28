/**
 * Automated proof of DR-06 (hash-chained audit trail) and FR-AUD-02
 * (append-only -- no role may ever edit or delete a row).
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withoutTenant, withTenant } from "../src/index.js";

afterAll(async () => {
  await closePool();
});

async function makeTenantWithUser(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = randomUUID();
  const userId = randomUUID();

  await withoutTenant(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, type, base_currency) VALUES ($1, $2, 'BUSINESS', 'KES')`,
      [tenantId, `Tenant ${tenantId}`],
    );
  });

  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, external_idp_subject, name, is_super_admin) VALUES ($1, $2, $3, 'Test User', false)`,
      [userId, tenantId, `test|${userId}`],
    );
  });

  return { tenantId, userId };
}

describe("audit log hash chain (DR-06)", () => {
  it("chains hash_prev of a new row to hash_self of the previous row, for the same tenant", async () => {
    const { tenantId, userId } = await makeTenantWithUser();
    const entityId = randomUUID();

    const [first, second] = await withTenant(tenantId, async (client) => {
      const r1 = await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after_state)
         VALUES ($1, $2, 'CREATE', 'journal', $3, '{"status":"DRAFT"}') RETURNING hash_prev, hash_self`,
        [tenantId, userId, entityId],
      );
      const r2 = await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, before_state, after_state)
         VALUES ($1, $2, 'UPDATE', 'journal', $3, '{"status":"DRAFT"}', '{"status":"POSTED"}') RETURNING hash_prev, hash_self`,
        [tenantId, userId, entityId],
      );
      return [r1.rows[0], r2.rows[0]];
    });

    expect(first.hash_prev).toBe("GENESIS");
    expect(first.hash_self).toBeTruthy();
    expect(second.hash_prev).toBe(first.hash_self);
    expect(second.hash_self).not.toBe(first.hash_self);
  });

  it("starts a fresh chain (GENESIS) for a different tenant, independent of other tenants' chains", async () => {
    const tenantA = await makeTenantWithUser();
    const tenantB = await makeTenantWithUser();

    const firstForA = await withTenant(tenantA.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after_state)
         VALUES ($1, $2, 'CREATE', 'journal', $3, '{}') RETURNING hash_prev`,
        [tenantA.tenantId, tenantA.userId, randomUUID()],
      );
      return result.rows[0];
    });

    const firstForB = await withTenant(tenantB.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after_state)
         VALUES ($1, $2, 'CREATE', 'journal', $3, '{}') RETURNING hash_prev`,
        [tenantB.tenantId, tenantB.userId, randomUUID()],
      );
      return result.rows[0];
    });

    expect(firstForA.hash_prev).toBe("GENESIS");
    expect(firstForB.hash_prev).toBe("GENESIS");
  });

  it("rejects an UPDATE on an audit log row unconditionally", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const id = await withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after_state)
         VALUES ($1, $2, 'CREATE', 'journal', $3, '{}') RETURNING id`,
        [tenantId, userId, randomUUID()],
      );
      return result.rows[0]!.id as string;
    });

    await expect(
      withTenant(tenantId, async (client) => {
        await client.query(`UPDATE audit_logs SET action = 'READ' WHERE id = $1`, [id]);
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects a DELETE on an audit log row unconditionally", async () => {
    const { tenantId, userId } = await makeTenantWithUser();

    const id = await withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after_state)
         VALUES ($1, $2, 'CREATE', 'journal', $3, '{}') RETURNING id`,
        [tenantId, userId, randomUUID()],
      );
      return result.rows[0]!.id as string;
    });

    await expect(
      withTenant(tenantId, async (client) => {
        await client.query(`DELETE FROM audit_logs WHERE id = $1`, [id]);
      }),
    ).rejects.toThrow(/append-only/i);
  });
});