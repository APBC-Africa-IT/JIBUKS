## 6.2 Accounts

Base path: `/api/v1/accounts` | All endpoints require `X-Tenant-Id`

> ⚠️ **Temporary auth note:** `X-Tenant-Id` and `X-Actor-User-Id` are development-only stand-ins for real authentication. Once identity/auth (OIDC/JWT) is live, these values will be derived automatically from your access token — you will stop sending them as headers. Nothing else about these endpoints will change.

---

### `POST /accounts`

Create a new account in the tenant's chart of accounts.

⚠️ **Requires:** `X-Tenant-Id`, `X-Actor-User-Id`

**Request:** `POST /api/v1/accounts`
`Content-Type: application/json`

**Request Body:**
```json
{
  "code": "1000",
  "name": "Cash",
  "type": "ASSET",
  "parentAccountId": null,
  "currency": "KES",
  "tags": []
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | ✅ Yes | Account code, unique **within this tenant** (two tenants may both use `1000`). Max 20 chars. |
| `name` | string | ✅ Yes | Display name of the account. Max 200 chars. |
| `type` | string | ✅ Yes | One of `ASSET`, `LIABILITY`, `EQUITY`, `INCOME`, `EXPENSE`. |
| `parentAccountId` | string (uuid) | No | ID of a grouping account this one sits under. If set, the parent must belong to the same tenant and have the same `type`. |
| `currency` | string | No | ISO 4217 code (e.g. `KES`). Omit to use the tenant's base currency. |
| `tags` | string[] | No | Free-form tags for departmental/branch/project reporting. Defaults to `[]`. |

**Success Response:** `201 Created`
```json
{
  "id": "541a185a-c76b-4e0a-9f0e-df5772307a74",
  "tenant_id": "33333333-3333-4333-8333-333333333333",
  "parent_account_id": null,
  "code": "1000",
  "name": "Cash",
  "type": "ASSET",
  "currency": null,
  "is_active": true,
  "is_postable": true,
  "tags": [],
  "created_at": "2026-07-30T10:25:50.110Z"
}
```

| Response Field | Type | Description |
|---|---|---|
| `id` | string (uuid) | Server-assigned account ID. |
| `tenant_id` | string (uuid) | The owning tenant — always mirrors your `X-Tenant-Id`. |
| `parent_account_id` | string (uuid) \| `null` | The parent account, if one was set. |
| `code` | string | Mirrored from the request. |
| `name` | string | Mirrored from the request. |
| `type` | string | Mirrored from the request. |
| `currency` | string \| `null` | `null` means "uses the tenant's base currency." |
| `is_active` | boolean | Always `true` on creation. |
| `is_postable` | boolean | `true` unless this account is a non-postable grouping account. |
| `tags` | string[] | Mirrored from the request. |
| `created_at` | string (ISO 8601) | Server timestamp of creation. |

**Error Response:** `400 Bad Request` — request body failed validation (e.g. invalid `type`)
```json
{
  "type": "tag:jibuks,2026:error/VALIDATION_ERROR",
  "title": "VALIDATION_ERROR",
  "status": 400,
  "detail": "The request body failed validation",
  "errors": [
    { "path": "type", "message": "Invalid enum value..." }
  ]
}
```

**Error Response:** `409 Conflict` — `code` already exists for this tenant
```json
{
  "type": "tag:jibuks,2026:error/DUPLICATE_VALUE",
  "title": "DUPLICATE_VALUE",
  "status": 409,
  "detail": "A record with this value already exists in accounts"
}
```

---

### `GET /accounts`

List every account belonging to the requesting tenant, ordered by `code`.

⚠️ **Requires:** `X-Tenant-Id`

**Request:** `GET /api/v1/accounts`

**Success Response:** `200 OK`
```json
{
  "data": [
    {
      "id": "541a185a-c76b-4e0a-9f0e-df5772307a74",
      "tenant_id": "33333333-3333-4333-8333-333333333333",
      "parent_account_id": null,
      "code": "1000",
      "name": "Cash",
      "type": "ASSET",
      "currency": null,
      "is_active": true,
      "is_postable": true,
      "tags": [],
      "created_at": "2026-07-30T10:25:50.110Z"
    }
  ]
}
```

Only accounts belonging to the tenant in `X-Tenant-Id` are ever returned — this is enforced at the database level, not just filtered in application code, so it cannot leak another tenant's accounts even in the event of an application bug.

---

### `GET /accounts/{id}`

Fetch a single account by ID.

⚠️ **Requires:** `X-Tenant-Id`

**Request:** `GET /api/v1/accounts/541a185a-c76b-4e0a-9f0e-df5772307a74`

**Success Response:** `200 OK` — same shape as the account object in `POST /accounts`.

**Error Response:** `404 Not Found`
```json
{
  "type": "tag:jibuks,2026:error/ACCOUNT_NOT_FOUND",
  "title": "ACCOUNT_NOT_FOUND",
  "status": 404,
  "detail": "Account 541a185a-... not found"
}
```
Returned both when the ID doesn't exist at all, and when it exists but belongs to a different tenant — the two cases are indistinguishable by design, so a client can never use this endpoint to confirm whether an ID exists in someone else's tenant.

---

### `POST /accounts/{id}/deactivate`

Deactivate an account. **Accounts are never deleted** — only deactivated. This preserves full history and every past journal entry that referenced the account.

⚠️ **Requires:** `X-Tenant-Id`, `X-Actor-User-Id`

**Request:** `POST /api/v1/accounts/541a185a-c76b-4e0a-9f0e-df5772307a74/deactivate`

**Success Response:** `200 OK` — the account, with `is_active: false`. Same shape as `POST /accounts`.

**Error Response:** `404 Not Found` — same shape as `GET /accounts/{id}`.

A deactivated account can no longer be posted to, but remains fully visible in `GET /accounts` and `GET /accounts/{id}` — it is not hidden or removed.

---

### `POST /accounts/{id}/reactivate`

Reverse a prior deactivation.

⚠️ **Requires:** `X-Tenant-Id`, `X-Actor-User-Id`

**Request:** `POST /api/v1/accounts/541a185a-c76b-4e0a-9f0e-df5772307a74/reactivate`

**Success Response:** `200 OK` — the account, with `is_active: true`. Same shape as `POST /accounts`.

**Error Response:** `404 Not Found` — same shape as `GET /accounts/{id}`.

---

### Notes for consuming clients

- Every write to this module (create, deactivate, reactivate) is recorded in an internal audit trail automatically. Nothing extra is required from a client for this — it happens as part of the same operation.
- `code` uniqueness is scoped **per tenant**. Do not assume a code is globally unique across the platform.
- There is currently no `PATCH`/update or `DELETE` endpoint for accounts, and none is planned — correcting a mistake means deactivating the wrong account and creating the right one, or (for financial corrections) reversing the affected journal entries.