# JiBUks API Reference

This document is the hand-written, human-readable companion to `openapi/openapi.yaml` (the machine-readable source of truth, served live at `/api/v1/docs`). Mobile and web teams should use this file to understand and consume backend endpoints.

**Conventions used throughout this document:**
- All endpoints are under `/api/v1` (SRS Section 9.1).
- `X-Tenant-Id` and `X-Actor-User-Id` headers are a **temporary development stand-in** for real authentication. Once identity/auth (OIDC/JWT) is live, these values will be derived automatically from your access token — this document will be updated at that point, and consuming clients will stop sending these headers manually.
- Error responses follow [RFC 7807](https://tools.ietf.org/html/rfc7807) problem-detail format: `{ type, title, status, detail, errors? }`.
- Money fields are always integer minor units (e.g. cents) with a separate currency code — never decimals.
- Date fields (e.g. `start_date`, `date`) are always plain calendar dates (`YYYY-MM-DD`), with no time component, per Section 9.1.

**Maintenance rule:** this file is updated as part of finishing a module, not as separate catch-up work. When a module's endpoints are built, tested, and working, its section is added here before moving to the next module.

---

## Table of Contents

- [6.1 Accounts](#61-accounts)
- [6.2 Periods](#62-periods)
- [6.3 Journals](#63-journals)

---

## 6.1 Accounts

Base path: `/api/v1/accounts` | All endpoints require `X-Tenant-Id`

> ⚠️ See the temporary auth note at the top of this document — applies to every endpoint below.

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

### Notes for consuming clients (Accounts)

- Every write to this module (create, deactivate, reactivate) is recorded in an internal audit trail automatically. Nothing extra is required from a client for this — it happens as part of the same operation.
- `code` uniqueness is scoped **per tenant**. Do not assume a code is globally unique across the platform.
- There is currently no `PATCH`/update or `DELETE` endpoint for accounts, and none is planned — correcting a mistake means deactivating the wrong account and creating the right one, or (for financial corrections) reversing the affected journal entries.

---

## 6.2 Periods

Base path: `/api/v1/periods` | All endpoints require `X-Tenant-Id`

> ⚠️ See the temporary auth note at the top of this document — applies to every endpoint below.

A journal can only be posted into an **open** period covering its date. Periods do not overlap and must be created before journals can be posted into the dates they cover.

---

### `POST /periods`

Create a new accounting period for the tenant.

⚠️ **Requires:** `X-Tenant-Id`, `X-Actor-User-Id`

**Request:** `POST /api/v1/periods`
`Content-Type: application/json`

**Request Body:**
```json
{
  "startDate": "2026-08-01",
  "endDate": "2026-08-31"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `startDate` | string (date) | ✅ Yes | First calendar date covered by this period, `YYYY-MM-DD`. |
| `endDate` | string (date) | ✅ Yes | Last calendar date covered by this period. Must not be before `startDate`. |

**Success Response:** `201 Created`
```json
{
  "id": "914c5153-9779-489d-a265-2b4a2fb2de5a",
  "tenant_id": "33333333-3333-4333-8333-333333333333",
  "start_date": "2026-08-01",
  "end_date": "2026-08-31",
  "status": "OPEN",
  "closed_by": null,
  "closed_at": null
}
```

| Response Field | Type | Description |
|---|---|---|
| `id` | string (uuid) | Server-assigned period ID. |
| `tenant_id` | string (uuid) | The owning tenant. |
| `start_date` / `end_date` | string (date) | Mirrored from the request. |
| `status` | string | One of `OPEN`, `CLOSED`, `LOCKED`. Always `OPEN` on creation. |
| `closed_by` | string (uuid) \| `null` | The user who closed/locked the period, if applicable. |
| `closed_at` | string (ISO 8601) \| `null` | When the period was closed/locked, if applicable. |

**Error Response:** `400 Bad Request` — `endDate` before `startDate`, or malformed dates.

---

### `GET /periods`

List every period for the requesting tenant, ordered by `start_date`.

⚠️ **Requires:** `X-Tenant-Id`

**Request:** `GET /api/v1/periods`

**Success Response:** `200 OK` — `{ "data": [ ...period objects... ] }`, same shape as `POST /periods`'s response.

---

### `GET /periods/{id}`

Fetch a single period by ID.

⚠️ **Requires:** `X-Tenant-Id`

**Success Response:** `200 OK` — same shape as `POST /periods`.

**Error Response:** `404 Not Found`.

---

### `POST /periods/{id}/close`

Close an open period. Only a period with `status: "OPEN"` can be closed.

⚠️ **Requires:** `X-Tenant-Id`, `X-Actor-User-Id`

**Request:** `POST /api/v1/periods/914c5153-9779-489d-a265-2b4a2fb2de5a/close`

**Success Response:** `200 OK` — the period, with `status: "CLOSED"`, `closed_by` set to the actor, `closed_at` set to the current time.

**Error Response:** `422 Unprocessable Entity` — the period is not currently `OPEN`:
```json
{
  "type": "tag:jibuks,2026:error/PERIOD_LOCKED",
  "title": "PERIOD_LOCKED",
  "status": 422,
  "detail": "Period 914c5153-... is already closed"
}
```

---

### `POST /periods/{id}/reopen`

Reopen a closed or locked period, restoring it to `OPEN`.

⚠️ **Requires:** `X-Tenant-Id`, `X-Actor-User-Id`

> ⚠️ **Not yet permission-gated.** Per the SRS, reopening a period should require a named permission (this action is inherently sensitive — it allows further posting into a period that was believed final). That permission check is **not yet implemented**, since role-based access control does not exist yet in the platform. Currently, any caller with a valid `X-Tenant-Id`/`X-Actor-User-Id` can reopen any period. This will change once RBAC lands — treat this endpoint as provisional.

**Request:** `POST /api/v1/periods/914c5153-9779-489d-a265-2b4a2fb2de5a/reopen`

**Success Response:** `200 OK` — the period, with `status: "OPEN"`, `closed_by` and `closed_at` both reset to `null`.

**Error Response:** `422 Unprocessable Entity` — the period is already `OPEN`.

---

### Notes for consuming clients (Periods)

- Every close/reopen action is recorded in the audit trail automatically, including which user performed it.
- A journal posting request will fail with `404 PERIOD_NOT_FOUND` if no period exists covering its date — create the relevant period first.
- A journal posting request will fail with `422 PERIOD_LOCKED` if the covering period is `CLOSED` or `LOCKED` — reopen the period first (see the permission caveat above).

---

## 6.3 Journals

Base path: `/api/v1/journals` | All endpoints require `X-Tenant-Id`

> ⚠️ See the temporary auth note at the top of this document — applies to every endpoint below.

This is the core accounting module. Every journal enforces **double-entry bookkeeping**: the sum of all `debitMinor` values across its lines must exactly equal the sum of all `creditMinor` values, in the journal's currency. This is checked both before the request reaches the database and independently by the database itself — a journal can never be stored unbalanced.

**Posted journals are immutable.** There is no update or delete endpoint. The only way to correct a posted journal is to reverse it (see below).

---

### `POST /journals`

Create and post a journal.

⚠️ **Requires:** `X-Tenant-Id`, `X-Actor-User-Id`

**Request:** `POST /api/v1/journals`
`Content-Type: application/json`

**Request Body:**
```json
{
  "clientUuid": "550e8400-e29b-41d4-a716-446655440099",
  "date": "2026-09-15",
  "currency": "KES",
  "description": "Cash sale",
  "source": "CASHBOOK",
  "reference": null,
  "branchId": null,
  "lines": [
    { "accountId": "541a185a-c76b-4e0a-9f0e-df5772307a74", "debitMinor": 100000, "creditMinor": 0 },
    { "accountId": "e5f2cf8a-4f7d-4a10-a807-66deb74ac350", "debitMinor": 0, "creditMinor": 100000 }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `clientUuid` | string (uuid) | ✅ Yes | Client-generated identifier for this journal. Used as the record's stable identity — supply a fresh UUID per journal (not the account or line IDs). |
| `date` | string (date) | ✅ Yes | Accounting date, `YYYY-MM-DD`. Must fall within an `OPEN` period for this tenant. |
| `currency` | string | ✅ Yes | ISO 4217 code. All lines are posted in this currency. |
| `description` | string | ✅ Yes | Human-readable description of the transaction. |
| `source` | string | No | One of `MANUAL`, `CASHBOOK`, `PAYMENT`, `IMPORT`, `COMMUNITY`, `OPENING`, `REVERSAL`. Defaults to `MANUAL`. |
| `reference` | string | No | Free-text reference (invoice number, receipt number, etc). |
| `branchId` | string (uuid) | No | Reserved for future branch support. Currently always `null`. |
| `lines` | array | ✅ Yes | At least 2 lines. See below. |

**Each line in `lines`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `accountId` | string (uuid) | ✅ Yes | Must belong to the same tenant, be `is_active: true`, and be `is_postable: true`. |
| `debitMinor` | integer | ✅ Yes | Integer minor units. Exactly one of `debitMinor`/`creditMinor` must be non-zero per line. |
| `creditMinor` | integer | ✅ Yes | Same as above. |
| `narrative` | string | No | Per-line note. |
| `projectId` | string (uuid) | No | Reserved for future project accounting. |
| `department` | string | No | Free-text department tag. |

**Success Response:** `201 Created`
```json
{
  "id": "18230383-e71e-45fe-ac5e-c98d18ca7fb2",
  "tenant_id": "33333333-3333-4333-8333-333333333333",
  "branch_id": null,
  "client_uuid": "550e8400-e29b-41d4-a716-446655440099",
  "period_id": "914c5153-9779-489d-a265-2b4a2fb2de5a",
  "date": "2026-09-15",
  "currency": "KES",
  "description": "Cash sale",
  "reference": null,
  "source": "CASHBOOK",
  "status": "POSTED",
  "reversal_of_journal_id": null,
  "created_by": "44444444-4444-4444-8444-444444444444",
  "approved_by": null,
  "created_at": "2026-08-01T16:17:52.119Z",
  "lines": [
    {
      "id": "4d4d5ab4-bc59-4c97-907d-a55e590ab187",
      "tenant_id": "33333333-3333-4333-8333-333333333333",
      "journal_id": "18230383-e71e-45fe-ac5e-c98d18ca7fb2",
      "account_id": "541a185a-c76b-4e0a-9f0e-df5772307a74",
      "debit_minor": "100000",
      "credit_minor": "0",
      "narrative": null,
      "project_id": null,
      "department": null
    }
  ]
}
```

> ⚠️ **`debit_minor` and `credit_minor` are returned as strings**, not numbers, in every response from this module (e.g. `"100000"`, not `100000`). This is deliberate — these are 64-bit values on the server, and JavaScript's native number type cannot safely represent every possible 64-bit integer. Parse them explicitly on the client (e.g. `parseInt(line.debit_minor, 10)`) rather than assuming JSON gives you a native number.

A journal is always created directly with `status: "POSTED"` — there is currently no draft/approval workflow exposed over the API.

**Error Response:** `422 Unprocessable Entity` — the journal does not balance:
```json
{
  "type": "tag:jibuks,2026:error/JOURNAL_UNBALANCED",
  "title": "JOURNAL_UNBALANCED",
  "status": 422,
  "detail": "Journal does not balance in KES: debits 5000 minor units, credits 3000 minor units, difference 2000 excess debit",
  "errors": [
    { "path": "lines", "message": "Total debits 5000" },
    { "path": "lines", "message": "Total credits 3000" }
  ]
}
```

**Error Response:** `404 Not Found` — an `accountId` does not exist, or belongs to a different tenant:
```json
{
  "type": "tag:jibuks,2026:error/ACCOUNT_NOT_FOUND",
  "title": "ACCOUNT_NOT_FOUND",
  "status": 404,
  "detail": "..."
}
```

**Error Response:** `404 Not Found` — no period covers the given `date`:
```json
{
  "type": "tag:jibuks,2026:error/PERIOD_NOT_FOUND",
  "title": "PERIOD_NOT_FOUND",
  "status": 404,
  "detail": "No accounting period covers 2099-01-01"
}
```

**Error Response:** `422 Unprocessable Entity` — the covering period is `CLOSED` or `LOCKED`:
```json
{
  "type": "tag:jibuks,2026:error/PERIOD_LOCKED",
  "title": "PERIOD_LOCKED",
  "status": 422,
  "detail": "..."
}
```

**Error Response:** `422 Unprocessable Entity` — a line references an inactive or non-postable account, has both/neither debit and credit set, or a currency mismatch. Same `problem+json` shape, with `title` set to `ACCOUNT_INACTIVE`, `ACCOUNT_NOT_POSTABLE`, `JOURNAL_LINE_AMBIGUOUS`, `JOURNAL_LINE_EMPTY`, or `CURRENCY_MISMATCH` as appropriate.

---

### `GET /journals`

List every journal for the requesting tenant, most recent first (`date DESC, created_at DESC`).

⚠️ **Requires:** `X-Tenant-Id`

**Success Response:** `200 OK` — `{ "data": [ ...journal objects, WITHOUT lines... ] }`. Fetch `GET /journals/{id}` for a specific journal's lines.

---

### `GET /journals/{id}`

Fetch a single journal, including its lines.

⚠️ **Requires:** `X-Tenant-Id`

**Success Response:** `200 OK` — same shape as `POST /journals`'s response.

**Error Response:** `404 Not Found`.

---

### `POST /journals/{id}/reverse`

The only way to correct a posted journal. Creates and posts a **new** journal with every line's debit and credit swapped, dated today, referencing the original.

⚠️ **Requires:** `X-Tenant-Id`, `X-Actor-User-Id`

**Request:** `POST /api/v1/journals/18230383-e71e-45fe-ac5e-c98d18ca7fb2/reverse`
```json
{
  "reason": "Posted in error"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | No | Included in the new journal's description. Defaults to `"No reason provided"` if omitted. |

**Success Response:** `201 Created` — a new journal, with:
- `source: "REVERSAL"`
- `reversal_of_journal_id` set to the original journal's `id`
- `date` set to **today**, not the original journal's date (a reversal is a new transaction, posted in the currently open period — it does not retroactively edit history)
- Every line's `debit_minor`/`credit_minor` swapped relative to the original

**The original journal is left completely unchanged** — same `status: "POSTED"`, same everything. There is no field on the original that gets updated to point at its reversal; the link is one-directional (the reversal points at the original, not the other way around). To find whether a journal has been reversed, look for another journal whose `reversal_of_journal_id` matches its `id`.

**Error Response:** `404 Not Found` — the journal to reverse does not exist.

**Error Response:** `422 Unprocessable Entity` — the journal was already reversed:
```json
{
  "type": "tag:jibuks,2026:error/JOURNAL_ALREADY_REVERSED",
  "title": "JOURNAL_ALREADY_REVERSED",
  "status": 422,
  "detail": "Journal 18230383-... was already reversed by 80430089-..."
}
```

**Error Response:** `422 Unprocessable Entity` — the journal is not currently `POSTED` (should not normally occur, since journals are always created as `POSTED`):
```json
{
  "type": "tag:jibuks,2026:error/JOURNAL_IMMUTABLE",
  "title": "JOURNAL_IMMUTABLE",
  "status": 422,
  "detail": "..."
}
```

---

### Notes for consuming clients (Journals)

- **Always generate a fresh `clientUuid` per journal.** It is the record's stable identity — reusing one will conflict with an existing journal for that tenant.
- **Parse `debit_minor`/`credit_minor` as strings**, not numbers — see the callout above.
- There is no update or delete endpoint for journals, by design. To correct a mistake, reverse the journal and post a new, correct one.
- A journal can only be reversed **once**. There is no way to reverse a reversal through this endpoint currently — if that's needed, post a new corrective journal manually.
- Every create and reverse action is recorded in the audit trail automatically.
- Create at least one open `Period` (see Section 6.2) covering your intended posting dates before attempting to post journals — otherwise every `POST /journals` will fail with `PERIOD_NOT_FOUND`.