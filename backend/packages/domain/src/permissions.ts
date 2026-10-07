/**
 * Permission catalogue and built-in roles.
 *
 * FR-RBAC-01: "role-based access control with permissions granular to
 * module and action". A permission is the string `module:action`. The
 * catalogue is fixed in code -- tenants compose custom roles FROM it
 * (FR-RBAC-02) but cannot invent new permissions, since only permissions
 * the server actually checks mean anything.
 *
 * Built-in (system) roles live here too, not in the database, so changing
 * what a built-in role can do reaches every tenant at once with no data
 * migration. FR-MIC-08's simplified micro-trader set (Owner, Cashier,
 * Agent) is a subset of these -- which roles a client offers a given
 * tenant is a presentation choice.
 *
 * Shared with mobile/web (C-01) so clients can hide what a user can't do;
 * the server still checks every request (client checks are never trusted).
 */

export const PERMISSIONS = [
  "users:view",
  "users:create",
  "users:edit",
  "roles:view",
  "roles:create",
  "roles:edit",
  "invites:view",
  "invites:create",
  "accounts:view",
  "accounts:create",
  "accounts:edit",
  "customers:view",
  "customers:create",
  "customers:edit",
  "suppliers:view",
  "suppliers:create",
  "suppliers:edit",
  "periods:view",
  "periods:create",
  "periods:close",
  "periods:reopen",
  "journals:view",
  "journals:create",
  "journals:reverse",
  "credit_sales:create",
  "cash_sales:create",
  "bills:create",
  "cheques:create",
  "cash_expenses:create",
  "payments:view",
  "payments:create",
  "invoices:view",
  "invoices:create",
  "invoices:issue",
  "invoices:cancel",
  "invoices:override_credit_limit",
  "reports:view",
  "tenant:edit",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export const SYSTEM_ROLE_KEYS = ["OWNER", "ACCOUNTANT", "CASHIER", "VIEWER", "AGENT"] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export function isSystemRoleKey(value: unknown): value is SystemRoleKey {
  return typeof value === "string" && (SYSTEM_ROLE_KEYS as readonly string[]).includes(value);
}

export interface SystemRole {
  readonly key: SystemRoleKey;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly Permission[];
}

const ADMIN_ONLY: ReadonlySet<Permission> = new Set([
  "users:create",
  "users:edit",
  "roles:create",
  "roles:edit",
  "invites:create",
  "tenant:edit",
]);

export const SYSTEM_ROLES: Readonly<Record<SystemRoleKey, SystemRole>> = {
  OWNER: {
    key: "OWNER",
    name: "Owner",
    description: "Full access, including managing users and roles.",
    permissions: PERMISSIONS,
  },
  ACCOUNTANT: {
    key: "ACCOUNTANT",
    name: "Accountant",
    description: "All bookkeeping, period close/reopen and reports. Cannot manage users or roles.",
    permissions: PERMISSIONS.filter((p) => !ADMIN_ONLY.has(p)),
  },
  CASHIER: {
    key: "CASHIER",
    name: "Cashier",
    description: "Records cash sales and cash expenses, collects M-Pesa payments and takes payments against invoices.",
    permissions: [
      "accounts:view",
      "customers:view",
      "suppliers:view",
      "cash_sales:create",
      "cash_expenses:create",
      "payments:view",
      "payments:create",
      // Sees invoices to take payment against them; can't raise or issue one.
      "invoices:view",
    ],
  },
  VIEWER: {
    key: "VIEWER",
    name: "Viewer",
    description: "Read-only access to records and reports.",
    permissions: PERMISSIONS.filter((p) => p.endsWith(":view")),
  },
  AGENT: {
    key: "AGENT",
    name: "Agent",
    description: "Records cash sales and collects M-Pesa payments (micro-trader tier).",
    permissions: ["accounts:view", "customers:view", "cash_sales:create", "payments:view", "payments:create"],
  },
};

/** Role given when none is specified (invites, direct user provisioning) -- least privilege. */
export const DEFAULT_ROLE: SystemRoleKey = "VIEWER";
