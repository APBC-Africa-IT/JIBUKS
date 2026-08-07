# JiBUks API Reference

This document is the hand-written, human-readable companion to `openapi/openapi.yaml` (the machine-readable source of truth, served live at `/api/v1/docs`). Mobile and web teams should use this file to understand and consume backend endpoints.

**Environments:**

| Environment | Base URL |
|---|---|
| **Staging** (build against this) | `https://dev-jibuksapi.apbcafrica.com/api/v1` |
| Local development | `http://localhost:3000/api/v1` |

Live, interactive documentation (Swagger UI, "Try it out" against real data): `https://dev-jibuksapi.apbcafrica.com/api/v1/docs`

**Conventions used throughout this document:**
- All endpoints are under `/api/v1` (SRS Section 9.1).
- **Every request requires** `Authorization: Bearer <token>`, where `<token>` is a genuine, Auth0-issued, RS256-signed JWT. This platform never sees, stores, or processes a password — identity is delegated entirely to Auth0 (constraint C-03). See [§7 Authentication](#7-authentication) below for the full flow.
- There is **no** `X-Tenant-Id` / `X-Actor-User-Id` header support. Tenant and actor are always derived from the verified token itself — a client can never claim to belong to a tenant that isn't genuinely theirs.
- Error responses follow [RFC 7807](https://tools.ietf.org/html/rfc7807) problem-detail format: `{ type, title, status, detail, errors? }`.
- Money fields are always integer minor units (e.g. cents) with a separate currency code — never decimals. **Example:** a sale of 1000.50 KES is sent/received as `debitMinor: 100050` (1000.50 × 100, since KES has 2 decimal places). Not every currency has 2 decimal places — UGX and RWF have 0, so `1500` UGX is *already* the full minor-unit value, not something to further multiply. Always convert using the specific currency's decimal count, never a hardcoded ×100.
- Date fields (e.g. `start_date`, `date`) are always plain calendar dates (`YYYY-MM-DD`), with no time component, per Section 9.1.
- `debit_minor` / `credit_minor` on journal lines are returned as **strings**, not numbers (e.g. `"100000"`) — these are 64-bit values that JavaScript's number type cannot always safely represent. Parse explicitly (`parseInt(x, 10)`) rather than assuming a native number.

**Maintenance rule:** this file is updated as part of finishing a module, not as separate catch-up work. When a module's endpoints are built, tested, and working, its section is added here before moving to the next module.

---

## Table of Contents

- [7. Authentication](#7-authentication)
- [7.1 Onboarding](#71-onboarding)
- [7.2 Users](#72-users)
- [7.3 Accounts](#73-accounts)
- [7.4 Periods](#74-periods)
- [7.5 Journals](#75-journals)

---

## 7. Authentication

Every endpoint in this API — with no exceptions — requires a genuine `Authorization: Bearer <token>` header. There are two distinct identity levels, and getting this distinction right matters:

| | Needs a genuine token | Needs an already-provisioned platform user |
|---|---|---|
| `POST /onboarding` | ✅ Yes | ❌ No — this is what creates that user |
| Everything else | ✅ Yes | ✅ Yes |

An **unauthenticated** request (missing/invalid/expired token) gets `401 UNAUTHORIZED` from every endpoint. A request with a genuine token, but whose identity has never onboarded, gets `404 USER_NOT_FOUND` from any endpoint other than `/onboarding`.

**How a client actually gets a token:** the OAuth 2.0 Authorization Code flow, with PKCE, against Auth0 — this is the standard secure pattern for mobile/web apps, distinct from the client-credentials flow used only for automated backend testing. The Auth0 login screen (email/password signup, or a social connection if enabled) is entirely Auth0's own hosted UI — this platform never renders a login form or touches a password.

| Environment | Auth0 Domain | Audience |
|---|---|---|
| Staging | `dev-1g8zdrubzj5enqii.us.auth0.com` | `https://api-staging.jibuks.com` |
| Local dev | `dev-1g8zdrubzj5enqii.us.auth0.com` | `https://apbc.jibuks.com` |

> ⚠️ Each real client app (the React Native app, a future web app) needs its own dedicated Auth0 **Native** or **Single Page Application** registration, with its own Client ID and its own callback URL — never reuse the developer test/M2M applications used to build this API.

**Token expiry and refresh:** access tokens are short-lived; implement standard refresh-token handling via whichever Auth0 SDK the client uses, so users aren't forced to re-authenticate constantly. Logging out is entirely client-side (just discard the stored token) — there is no server-side session to end, since every request is independently verified from the token alone. Logging back in later works automatically and indefinitely: the token's `sub` claim never changes for a given person, so the same Auth0 account always resolves to the same platform user and tenant, no matter how many times they log out and back in.

---

## 7.1 Onboarding

Base path: `/api/v1/onboarding`

Self-service sign-up: creates a **brand-new tenant and its first user, together, atomically**. This is the app's very first screen for someone who has never used JiBUks before — directly supporting FR-MIC-07's minimal-friction merchant onboarding.

⚠️ **Requires:** a genuine Auth0 token. Does **not** require an already-provisioned platform user — that's precisely what this endpoint creates.

---

### `POST /onboarding`

**Request:** `POST /api/v1/onboarding`
`Content-Type: application/json`

**Request Body:**
```json
{
  "tenantName": "Jane's Kiosk",
  "tenantType": "BUSINESS",
  "baseCurrency": "KES",
  "userName": "Jane Wanjiru",
  "email": "jane@example.com"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `tenantName` | string | ✅ Yes | The business/household/NGO name. Max 200 chars. |
| `tenantType` | string | ✅ Yes | One of `BUSINESS`, `NGO`, `HOUSEHOLD`. |
| `baseCurrency` | string | ✅ Yes | ISO 4217 code (e.g. `KES`). |
| `userName` | string | ✅ Yes | Display name of the first user (the person onboarding). Max 200 chars. |
| `email` | string | No | Contact email. Not verified against the token — see note below. |
| `phone` | string | No | Contact phone. |

The new user's `external_idp_subject` is taken directly from the verified token's `sub` claim — not from anything in the request body, and not something the client can override.

**Success Response:** `201 Created`
```json
{
  "tenant": {
    "id": "75d11c00-1694-4461-8048-a49d305b9ada",
    "name": "Jane's Kiosk",
    "type": "BUSINESS",
    "base_currency": "KES",
    "accounting_framework": "GAAP",
    "plan_tier": "STARTER",
    "status": "ACTIVE",
    "created_at": "2026-08-03T00:55:32.051Z"
  },
  "user": {
    "id": "734d2f93-98e0-4fc8-b4e9-8f622777bc63",
    "tenant_id": "75d11c00-1694-4461-8048-a49d305b9ada",
    "external_idp_subject": "auth0|6a6fe4e1275c708a0cd882df",
    "name": "Jane Wanjiru",
    "email": null,
    "phone": null,
    "status": "ACTIVE",
    "mfa_enabled": false,
    "is_super_admin": false,
    "created_at": "2026-08-03T00:55:32.051Z"
  }
}
```

**Error Response:** `401 Unauthorized` — missing/invalid token. See [§7 Authentication](#7-authentication).

**Error Response:** `400 Bad Request` — request body failed validation. Same `VALIDATION_ERROR` shape as every other module.

**Error Response:** `409 Conflict` — this identity has already onboarded before:
```json
{
  "type": "tag:jibuks,2026:error/USER_ALREADY_EXISTS",
  "title": "USER_ALREADY_EXISTS",
  "status": 409,
  "detail": "This identity is already onboarded (user 734d2f93-..., tenant 75d11c00-...)"
}
```

**A client should treat `409` from this endpoint as expected, normal behavior for a returning user** — not an error state to show — and route them straight into the app instead of an onboarding failure screen. There is no separate "log in" endpoint to call in that case; any authenticated request (e.g. `GET /users/{id}`) will resolve to their existing account correctly.

### Notes for consuming clients (Onboarding)

- One Auth0 identity maps to exactly **one** tenant, permanently. There is currently no supported way for one person to own multiple separate businesses under one login.
- Both the tenant creation and the user creation are recorded in the audit trail, with the new user recorded as the actor of their own creation — the only case in the platform where this self-attribution is correct, since nobody else could possibly exist yet at that moment.

---

## 7.2 Users

Base path: `/api/v1/users`

Provisioning **additional** users into an **already-existing** tenant — an owner or existing teammate adding a coworker.

⚠️ **Requires:** a genuine Auth0 token **and** an already-provisioned platform user (i.e. the caller must have onboarded already).

> ⚠️ **Open design question, not yet resolved:** `externalIdpSubject` below must be the *new* teammate's own future Auth0 identity, not the caller's. How that value is actually communicated in a real invite flow (an invite link? an email claim step?) has not yet been designed — this is a known gap between backend and frontend, flagged for a joint decision.

---

### `POST /users`

Creates a user in the **caller's own** tenant — the tenant is always taken from the caller's verified identity, never from the request body, so a caller can only ever add users to their own business.

**Request:** `POST /api/v1/users`
`Content-Type: application/json`

**Request Body:**
```json
{
  "externalIdpSubject": "auth0|64f2a1b3c9d...",
  "name": "New Teammate",
  "email": "teammate@example.com"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `externalIdpSubject` | string | ✅ Yes | The new person's own Auth0 `sub`. Not verified as a real, existing Auth0 identity at creation time — becomes meaningful the first time that person actually logs in. |
| `name` | string | ✅ Yes | Display name. Max 200 chars. |
| `email` | string | No | Contact email. |
| `phone` | string | No | Contact phone. |

**Success Response:** `201 Created`
```json
{
  "id": "fa7420b7-dc44-4058-a146-f624adaae031",
  "tenant_id": "75d11c00-1694-4461-8048-a49d305b9ada",
  "external_idp_subject": "auth0|64f2a1b3c9d...",
  "name": "New Teammate",
  "email": "teammate@example.com",
  "phone": null,
  "status": "ACTIVE",
  "mfa_enabled": false,
  "is_super_admin": false,
  "created_at": "2026-08-03T01:18:21.190Z"
}
```

The audit log records the **caller** as the actor of this action — not the new teammate — since the caller is the one who genuinely performed it.

**Error Response:** `401 Unauthorized` — missing/invalid token.

**Error Response:** `404 Not Found` — the token is genuine, but its identity has never onboarded:
```json
{
  "type": "tag:jibuks,2026:error/USER_NOT_FOUND",
  "title": "USER_NOT_FOUND",
  "status": 404,
  "detail": "..."
}
```

**Error Response:** `409 Conflict` — `externalIdpSubject` already belongs to a user somewhere on the platform (identities are globally unique, not scoped per tenant):
```json
{
  "type": "tag:jibuks,2026:error/USER_ALREADY_EXISTS",
  "title": "USER_ALREADY_EXISTS",
  "status": 409,
  "detail": "A user for this identity already exists (id ...)"
}
```

---

### `GET /users`

List every user in the caller's tenant.

**Success Response:** `200 OK` — `{ "data": [ ...user objects... ] }`.

---

### `GET /users/{id}`

Fetch a single user by ID.

**Success Response:** `200 OK` — same shape as `POST /users`'s response.

**Error Response:** `404 Not Found` — doesn't exist, or belongs to a different tenant (indistinguishable by design).

### Notes for consuming clients (Users)

- Every user added to a tenant currently has **full access** to everything in that tenant — there is no role/permission system yet (a known, planned gap, not an oversight).
- A person, once provisioned anywhere, is permanently tied to that one tenant — there's no supported way to move a user between tenants.

---

## 7.3 Accounts

Base path: `/api/v1/accounts`

---

### `POST /accounts`

Create a new account in the tenant's chart of accounts.

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
| `tenant_id` | string (uuid) | The owning tenant — always the caller's own. |
| `parent_account_id` | string (uuid) \| `null` | The parent account, if one was set. |
| `code` | string | Mirrored from the request. |
| `name` | string | Mirrored from the request. |
| `type` | string | Mirrored from the request. |
| `currency` | string \| `null` | `null` means "uses the tenant's base currency." |
| `is_active` | boolean | Always `true` on creation. |
| `is_postable` | boolean | `true` unless this account is a non-postable grouping account. |
| `tags` | string[] | Mirrored from the request. |
| `created_at` | string (ISO 8601) | Server timestamp of creation. |

**Error Response:** `401 Unauthorized` — missing/invalid token.

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

List every account belonging to the caller's tenant, ordered by `code`.

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

Only accounts belonging to the caller's tenant are ever returned — this is enforced at the database level, not just filtered in application code, so it cannot leak another tenant's accounts even in the event of an application bug.

---

### `GET /accounts/{id}`

Fetch a single account by ID.

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

**Request:** `POST /api/v1/accounts/541a185a-c76b-4e0a-9f0e-df5772307a74/deactivate`

**Success Response:** `200 OK` — the account, with `is_active: false`. Same shape as `POST /accounts`.

**Error Response:** `404 Not Found` — same shape as `GET /accounts/{id}`.

A deactivated account can no longer be posted to, but remains fully visible in `GET /accounts` and `GET /accounts/{id}` — it is not hidden or removed.

---

### `POST /accounts/{id}/reactivate`

Reverse a prior deactivation.

**Request:** `POST /api/v1/accounts/541a185a-c76b-4e0a-9f0e-df5772307a74/reactivate`

**Success Response:** `200 OK` — the account, with `is_active: true`. Same shape as `POST /accounts`.

**Error Response:** `404 Not Found` — same shape as `GET /accounts/{id}`.

---

### Notes for consuming clients (Accounts)

- Every write to this module (create, deactivate, reactivate) is recorded in an internal audit trail automatically. Nothing extra is required from a client for this — it happens as part of the same operation.
- `code` uniqueness is scoped **per tenant**. Do not assume a code is globally unique across the platform.
- There is currently no `PATCH`/update or `DELETE` endpoint for accounts, and none is planned — correcting a mistake means deactivating the wrong account and creating the right one, or (for financial corrections) reversing the affected journal entries.

---

## 7.4 Periods

Base path: `/api/v1/periods`

A journal can only be posted into an **open** period covering its date. Periods do not overlap and must be created before journals can be posted into the dates they cover.

---

### `POST /periods`

Create a new accounting period for the tenant.

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

List every period for the caller's tenant, ordered by `start_date`.

**Success Response:** `200 OK` — `{ "data": [ ...period objects... ] }`, same shape as `POST /periods`'s response.

---

### `GET /periods/{id}`

Fetch a single period by ID.

**Success Response:** `200 OK` — same shape as `POST /periods`.

**Error Response:** `404 Not Found`.

---

### `POST /periods/{id}/close`

Close an open period. Only a period with `status: "OPEN"` can be closed.

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

> ⚠️ **Not yet permission-gated.** Per the SRS, reopening a period should require a named permission (this action is inherently sensitive — it allows further posting into a period that was believed final). That permission check is **not yet implemented**, since role-based access control does not exist yet in the platform. Currently, any authenticated caller in the tenant can reopen any period. This will change once RBAC lands — treat this endpoint as provisional.

**Request:** `POST /api/v1/periods/914c5153-9779-489d-a265-2b4a2fb2de5a/reopen`

**Success Response:** `200 OK` — the period, with `status: "OPEN"`, `closed_by` and `closed_at` both reset to `null`.

**Error Response:** `422 Unprocessable Entity` — the period is already `OPEN`.

---

### Notes for consuming clients (Periods)

- Every close/reopen action is recorded in the audit trail automatically, including which user performed it.
- A journal posting request will fail with `404 PERIOD_NOT_FOUND` if no period exists covering its date — create the relevant period first.
- A journal posting request will fail with `422 PERIOD_LOCKED` if the covering period is `CLOSED` or `LOCKED` — reopen the period first (see the permission caveat above).

---

## 7.5 Journals

Base path: `/api/v1/journals`

This is the core accounting module. Every journal enforces **double-entry bookkeeping**: the sum of all `debitMinor` values across its lines must exactly equal the sum of all `creditMinor` values, in the journal's currency. This is checked both before the request reaches the database and independently by the database itself — a journal can never be stored unbalanced.

**Posted journals are immutable.** There is no update or delete endpoint. The only way to correct a posted journal is to reverse it (see below).

---

### `POST /journals`

Create and post a journal.

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

> ⚠️ **`debit_minor` and `credit_minor` are returned as strings**, not numbers, in every response from this module. See the conventions section at the top of this document.

A journal is always created directly with `status: "POSTED"` — there is currently no draft/approval workflow exposed over the API.

**Error Response:** `401 Unauthorized` — missing/invalid token.

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

List every journal for the caller's tenant, most recent first (`date DESC, created_at DESC`).

**Success Response:** `200 OK` — `{ "data": [ ...journal objects, WITHOUT lines... ] }`. Fetch `GET /journals/{id}` for a specific journal's lines.

---

### `GET /journals/{id}`

Fetch a single journal, including its lines.

**Success Response:** `200 OK` — same shape as `POST /journals`'s response.

**Error Response:** `404 Not Found`.

---

### `POST /journals/{id}/reverse`

The only way to correct a posted journal. Creates and posts a **new** journal with every line's debit and credit swapped, dated today, referencing the original.

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
- Create at least one open `Period` (see §7.4) covering your intended posting dates before attempting to post journals — otherwise every `POST /journals` will fail with `PERIOD_NOT_FOUND`.