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
- **Every request requires** `Authorization: Bearer <token>`, where `<token>` is a genuine, Auth0-issued, RS256-signed JWT, **except** `GET /invites/{token}` (the public invite preview). This platform never sees, stores, or processes a password — identity is delegated entirely to Auth0 (constraint C-03). See [§7 Authentication](#7-authentication) below for the full flow.
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
- [7.3 Invites](#73-invites)
- [7.4 Accounts](#74-accounts)
- [7.5 Customers](#75-customers)
- [7.6 Suppliers](#76-suppliers)
- [7.7 Periods](#77-periods)
- [7.8 Journals](#78-journals)
- [7.9 Credit Sales](#79-credit-sales)
- [7.10 Cash Sales](#710-cash-sales)

---

## 7. Authentication

Every endpoint in this API requires a genuine `Authorization: Bearer <token>` header, with exactly one exception (`GET /invites/{token}`, see §7.3). There are two distinct identity levels beyond that:

| | Needs a genuine token | Needs an already-provisioned platform user |
|---|---|---|
| `POST /onboarding` | ✅ Yes | ❌ No — this is what creates that user |
| `POST /invites/{token}/accept` | ✅ Yes | ❌ No — this is what creates that user |
| Everything else | ✅ Yes | ✅ Yes |

An **unauthenticated** request (missing/invalid/expired token) gets `401 UNAUTHORIZED` from every endpoint that requires one. A request with a genuine token, but whose identity has never onboarded, gets `404 USER_NOT_FOUND` from any endpoint other than `/onboarding` and `/invites/{token}/accept`.

**How a client actually gets a token:** the OAuth 2.0 Authorization Code flow, with PKCE, against Auth0 — this is the standard secure pattern for mobile/web apps, distinct from the client-credentials flow used only for automated backend testing. The Auth0 login screen (email/password signup, Google, or any other configured social connection) is entirely Auth0's own hosted UI — this platform never renders a login form or touches a password.

| Environment | Auth0 Domain | Audience |
|---|---|---|
| Staging | `dev-1g8zdrubzj5enqii.us.auth0.com` | `https://api-staging.jibuks.com` |
| Local dev | `dev-1g8zdrubzj5enqii.us.auth0.com` | `https://apbc.jibuks.com` |

> ⚠️ Each real client app (the React Native app, a future web app) needs its own dedicated Auth0 **Native** or **Single Page Application** registration, with its own Client ID and its own callback URL — never reuse the developer test/M2M applications used to build this API. Whichever app is used, it must also be explicitly **authorized on the relevant API** (Auth0 dashboard → the API → Application Access / "Always grant all permissions") — a real, easy-to-miss step; skipping it produces an `invalid_request` / "Client is not authorized to access resource server" error, not a helpful hint pointing at this setting.

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

**Error Response:** `401 Unauthorized` — missing/invalid token.

**Error Response:** `400 Bad Request` — request body failed validation.

**Error Response:** `409 Conflict` — this identity has already onboarded before:
```json
{
  "type": "tag:jibuks,2026:error/USER_ALREADY_EXISTS",
  "title": "USER_ALREADY_EXISTS",
  "status": 409,
  "detail": "This identity is already onboarded (user 734d2f93-..., tenant 75d11c00-...)"
}
```

**A client should treat `409` from this endpoint as expected, normal behavior for a returning user** — not an error state to show — and route them straight into the app instead of an onboarding failure screen.

### Notes for consuming clients (Onboarding)

- One Auth0 identity maps to exactly **one** tenant, permanently.
- Both the tenant creation and the user creation are recorded in the audit trail, with the new user recorded as the actor of their own creation.

---

## 7.2 Users

Base path: `/api/v1/users` 

Provisioning **additional** users into an **already-existing** tenant, when the caller already knows the new person's Auth0 identity in advance. **In practice, prefer §7.3 Invites instead** — this endpoint requires knowing a value (`externalIdpSubject`) that's normally impossible to know ahead of someone's first login. It remains useful for edge cases (e.g. migrating a known identity from elsewhere).

⚠️ **Requires:** a genuine Auth0 token **and** an already-provisioned platform user (i.e. the caller must have onboarded already).

---

### `POST /users` 

Creates a user in the **caller's own** tenant — the tenant is always taken from the caller's verified identity, never from the request body.

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
| `externalIdpSubject` | string | ✅ Yes | The new person's own Auth0 `sub`. See the caveat above — normally impractical to know in advance; use Invites instead. |
| `name` | string | ✅ Yes | Display name. Max 200 chars. |
| `email` | string | No | Contact email. |
| `phone` | string | No | Contact phone. |

**Success Response:** `201 Created` — same shape as a user object in `POST /onboarding`'s response. The audit log records the **caller** as the actor — not the new teammate.

**Error Response:** `401 Unauthorized`, `404 USER_NOT_FOUND` (caller never onboarded), `409 USER_ALREADY_EXISTS` (identity already provisioned somewhere — identities are globally unique, not scoped per tenant).

---

### `GET /users/me` 

Returns the caller's own user record. **Use this on app load to decide whether to show onboarding or go straight into the app** — much more reliable than guessing locally on-device, since it works correctly across reinstalls and for invited teammates too, not just onboarded owners.

**Success Response:** `200 OK` — same shape as a user object elsewhere.

**Error Response:** `404 USER_NOT_FOUND` — this identity has never onboarded or been invited/accepted anywhere. Show the onboarding screen in this case.

---

### `GET /users` / `GET /users/{id}` 

List / fetch users in the caller's tenant. Standard shapes, see `POST /users`'s response for the object shape.

### Notes for consuming clients (Users)

- Every user added to a tenant currently has **full access** to everything in that tenant — no role/permission system yet.

---

## 7.3 Invites

Base path: `/api/v1/invites` 

**This is the real, recommended way to add a teammate** — it solves the problem `POST /users` cannot: nobody knows their own Auth0 `sub` before they've logged in once. An invite decouples "who was invited" (an email address) from "who they turn out to be in Auth0" (resolved only when they accept).

Three different auth levels live in this one module — read carefully:

| Endpoint | Auth |
|---|---|
| `POST /invites` | Full identity (existing tenant user) |
| `GET /invites` | Full identity (existing tenant user) |
| `GET /invites/{token}` | **None at all** — public, shown before the invitee has logged in anywhere |
| `POST /invites/{token}/accept` | Genuine token only, same tier as `/onboarding` |

A real invite email is sent via Resend, from a verified sending domain (`mail.apbcafrica.com`) — this works for any real recipient address, not just a test account.

---

### `POST /invites` 

An existing tenant user invites someone by email.

**Request Body:**
```json
{
  "email": "colleague@example.com",
  "name": "Colleague Name"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | ✅ Yes | The invitee's real email address — the invite is sent here. |
| `name` | string | No | Optional display name to prefill. |

**Success Response:** `201 Created` 
```json
{
  "id": "30d71166-413c-40b2-a703-029acca36c0d",
  "tenant_id": "5f56fb3e-34fe-4609-a5b1-8ea36c806c85",
  "email": "colleague@example.com",
  "name": "Colleague Name",
  "status": "PENDING",
  "invited_by": "6b377361-1a90-4dfd-b2e1-9b93eb1bddde",
  "accepted_by": null,
  "created_at": "2026-08-12T06:39:39.993Z",
  "expires_at": "2026-08-19T06:39:39.992Z",
  "accepted_at": null
}
```

> ⚠️ **The raw invite token, and its hash, are never included in any API response.** The raw token exists only inside the email itself. This is deliberate — returning it over the API would defeat the point of hashing it before storage.

**Error Response:** `401 Unauthorized`, `400 VALIDATION_ERROR` (invalid email).

**Email delivery note:** if the email doesn't arrive, the invite record still exists and is still valid (email sending failure never blocks invite creation) — but check server logs for a Resend delivery error. A common cause during development: Resend restricts unverified accounts to sending only to the account owner's own address; this is resolved by verifying a real sending domain (already done for `mail.apbcafrica.com`).

---

### `GET /invites` 

List invites for the caller's tenant. `{ "data": [ ...invite objects... ] }`, same shape as above, never including the token/hash.

---

### `GET /invites/{token}` — public, no auth

Shown to the invitee **before** they've logged in anywhere — lets the app display "You've been invited to join X" prior to sending them into Auth0's login screen.

**Request:** `GET /api/v1/invites/wTfNoVD4aCzpqLFR_kboG9B9ikxSmF5lJbOPk_6bM_g` 
(the raw token, extracted from the link in the invite email)

**Success Response:** `200 OK` 
```json
{
  "tenantName": "Jibuks Test",
  "inviterName": "Test User",
  "status": "PENDING",
  "expired": false
}
```

**Error Response:** `404 Not Found` — token doesn't exist.

---

### `POST /invites/{token}/accept` 

The invitee, now logged in via Auth0 for the first time, accepts the invite.

⚠️ **Requires:** a genuine Auth0 token. Does **not** require an already-provisioned platform user — accepting is what creates it.

**Request:** `POST /api/v1/invites/wTfNoVD4aCzpqLFR_kboG9B9ikxSmF5lJbOPk_6bM_g/accept` 
```json
{
  "name": "Colleague's Real Name"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ Yes | The invitee's display name. |

The new user's `external_idp_subject` comes from the **verified token's `sub` claim** — never from the request body. The tenant comes from the invite itself.

**Success Response:** `201 Created` 
```json
{
  "tenantId": "5f56fb3e-34fe-4609-a5b1-8ea36c806c85",
  "userId": "8a1f2c3d-...-..."
}
```

**Error Response:** `401 Unauthorized` — missing/invalid token.

**Error Response:** `404 Not Found` — the token doesn't correspond to any invite.

**Error Response:** `409 Conflict` — the invite is no longer valid (already accepted, revoked, or expired), **or** this identity already has an account somewhere else on the platform (one identity, one tenant, permanently — same rule as onboarding):
```json
{
  "type": "tag:jibuks,2026:error/USER_ALREADY_EXISTS",
  "title": "USER_ALREADY_EXISTS",
  "status": 409,
  "detail": "This identity already has an account (user ..., tenant ...)"
}
```

### Notes for consuming clients (Invites)

- Invites expire after **7 days**.
- An invite can only be accepted **once** — a second attempt with the same token fails with `409`.
- The accept link in the email currently points at a placeholder URL (`https://dev-jibuksapi.apbcafrica.com/accept-invite?token=...`) — **this is not a real page**; there is no backend route there. A real client app must extract the `token` query parameter from that link and call `POST /invites/{token}/accept` itself, after the invitee has logged in. The base URL is configurable server-side (`INVITE_ACCEPT_BASE_URL`) and should be updated to a real app deep link once the mobile/web app exists.
- Proven end-to-end with two genuinely distinct real human Auth0 identities (an inviter and an invitee), not just automated tests.

---

## 7.4 Accounts

Base path: `/api/v1/accounts` 

---

### `POST /accounts` 

Create a new account in the tenant's chart of accounts.

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
| `code` | string | ✅ Yes | Account code, unique **within this tenant**. Max 20 chars. |
| `name` | string | ✅ Yes | Display name. Max 200 chars. |
| `type` | string | ✅ Yes | One of `ASSET`, `LIABILITY`, `EQUITY`, `INCOME`, `EXPENSE`. |
| `parentAccountId` | string (uuid) | No | Must belong to the same tenant and have the same `type`. |
| `currency` | string | No | ISO 4217 code. Omit to use the tenant's base currency. |
| `tags` | string[] | No | Defaults to `[]`. |

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

**Error Response:** `401 Unauthorized`, `400 VALIDATION_ERROR`, `409 DUPLICATE_VALUE` (code already exists for this tenant).

---

### `GET /accounts` / `GET /accounts/{id}` 

List / fetch accounts for the caller's tenant, enforced at the database level. Each account includes a server-computed `balance_minor`.

**Query Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `as_of` | string (date) | No | Point-in-time cutoff for `balance_minor` — only `POSTED` journals dated on or before this date count. Omit for the balance as of now. |

**Success Response:** `200 OK` 
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
  "created_at": "2026-07-30T10:25:50.110Z",
  "balance_minor": "1500000"
}
```

`balance_minor` is the net of `POSTED` journal lines against the account, on its natural side (debit for `ASSET`/`EXPENSE`, credit for `LIABILITY`/`EQUITY`/`INCOME`) — same 64-bit-safe string convention as `debit_minor`/`credit_minor`. `DRAFT`/`PENDING_APPROVAL` journals never affect it.

**Error Response:** `400 VALIDATION_ERROR` (malformed `as_of`), `404 ACCOUNT_NOT_FOUND` — doesn't exist, or belongs to a different tenant (indistinguishable by design).

---

### `POST /accounts/{id}/deactivate` / `POST /accounts/{id}/reactivate` 

**Accounts are never deleted** — only deactivated/reactivated, preserving full history.

### Notes for consuming clients (Accounts)

- `code` uniqueness is scoped **per tenant**, not global.
- No update/delete endpoint exists, by design.
- `balance_minor` is only present on `GET /accounts` and `GET /accounts/{id}` responses — not on `POST /accounts` or the deactivate/reactivate responses.

---

## 7.5 Customers

Base path: `/api/v1/customers` 

A customer is a name list entry, deliberately separate from the chart of accounts (`accounts`) — it carries contact metadata (`phone`, `email`, `address`) that has no place on an account row, mirroring how QuickBooks keeps Customers as their own list rather than sub-accounts of Accounts Receivable.

---

### `POST /customers` 

Create a new customer for the tenant.

**Request Body:**
```json
{
  "name": "Jane Trader",
  "phone": "+254700000000",
  "email": "jane@example.com",
  "address": null,
  "tags": []
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ Yes | Display name. Max 200 chars. |
| `phone` | string | No | Max 20 chars. |
| `email` | string | No | Must be a valid email if given. |
| `address` | string | No | Max 500 chars. |
| `tags` | string[] | No | Defaults to `[]`. |

**Success Response:** `201 Created` — same shape as `GET /customers/{id}` below, minus `balance_minor` (a brand-new customer has no journal history yet).

**Error Response:** `401 Unauthorized`, `400 VALIDATION_ERROR`.

---

### `GET /customers` / `GET /customers/{id}` 

List / fetch customers for the caller's tenant. Each customer includes a server-computed `balance_minor`.

**Query Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `as_of` | string (date) | No | Point-in-time cutoff for `balance_minor` — only `POSTED` journals dated on or before this date count. Omit for the balance as of now. |

**Success Response:** `200 OK` 
```json
{
  "id": "6c1a2f3e-2b4a-4c1a-9c1a-2b4a4c1a9c1a",
  "tenant_id": "33333333-3333-4333-8333-333333333333",
  "name": "Jane Trader",
  "phone": "+254700000000",
  "email": "jane@example.com",
  "address": null,
  "is_active": true,
  "tags": [],
  "created_at": "2026-07-30T10:25:50.110Z",
  "balance_minor": "150000"
}
```

`balance_minor` is the net of `POSTED` journal lines **tagged with this customer's id** (via `customerId` on a journal line — see [7.8 Journals](#78-journals)), on the debit side (AR-like: a customer owing money is a debit balance). It is not tied to any particular account — a customer can be tagged on lines against different accounts and the balance still nets correctly.

**Error Response:** `400 VALIDATION_ERROR` (malformed `as_of`), `404 CUSTOMER_NOT_FOUND` — doesn't exist, or belongs to a different tenant (indistinguishable by design).

---

### `POST /customers/{id}/deactivate` / `POST /customers/{id}/reactivate` 

**Customers are never deleted** — only deactivated/reactivated, preserving full history. Deactivating a customer does **not** block posting further journal lines tagged with it in this phase.

### Notes for consuming clients (Customers)

- `balance_minor` is only present on `GET /customers` and `GET /customers/{id}` responses.
- For the guided invoice flow, see [7.9 Credit Sales](#79-credit-sales) — `POST /credit-sales` builds the balanced AR/revenue/tax journal for you. `POST /journals` directly with `customerId` set is still available for anything that doesn't fit that shape.

---

## 7.6 Suppliers

Base path: `/api/v1/suppliers` 

Mirrors [7.5 Customers](#75-customers) exactly, except a supplier's `balance_minor` sits on the **credit** side (AP-like: money owed to them is a credit balance) and journal lines attribute to it via `supplierId` instead of `customerId`.

---

### `POST /suppliers` 

Same request shape as `POST /customers`, e.g.:
```json
{ "name": "Acme Supplies", "phone": "+254711111111" }
```

**Error Response:** `401 Unauthorized`, `400 VALIDATION_ERROR`.

---

### `GET /suppliers` / `GET /suppliers/{id}` 

Same query parameters (`as_of`) and shape as `GET /customers`, with `balance_minor` computed from lines tagged via `supplierId`:
```json
{
  "id": "9a2f3e6c-4a2b-4c1a-9c1a-4a2b4c1a9c1a",
  "tenant_id": "33333333-3333-4333-8333-333333333333",
  "name": "Acme Supplies",
  "phone": "+254711111111",
  "email": null,
  "address": null,
  "is_active": true,
  "tags": [],
  "created_at": "2026-07-30T10:25:50.110Z",
  "balance_minor": "80000"
}
```

**Error Response:** `400 VALIDATION_ERROR` (malformed `as_of`), `404 SUPPLIER_NOT_FOUND`.

---

### `POST /suppliers/{id}/deactivate` / `POST /suppliers/{id}/reactivate` 

**Suppliers are never deleted** — only deactivated/reactivated, same as customers.

### Notes for consuming clients (Suppliers)

- A journal line may carry `customerId` **or** `supplierId`, never both — `400 VALIDATION_ERROR` otherwise.
- There is no guided "Write Bill" endpoint yet — attributing a journal line to a supplier today means posting via `POST /journals` directly with `supplierId` set on the relevant line.

---

## 7.7 Periods

Base path: `/api/v1/periods` 

A journal can only be posted into an **open** period covering its date.

---

### `POST /periods` 

```json
{
  "startDate": "2026-08-01",
  "endDate": "2026-08-31"
}
```

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

### `GET /periods` / `GET /periods/{id}` 

Standard list/get.

### `POST /periods/{id}/close` 

Only an `OPEN` period can be closed. `422 PERIOD_LOCKED` otherwise.

### `POST /periods/{id}/reopen` 

> ⚠️ **Not yet permission-gated** — any authenticated tenant user can reopen any period. RBAC will change this; treat as provisional.

### Notes for consuming clients (Periods)

- `POST /journals` fails with `404 PERIOD_NOT_FOUND` if no period covers its date, or `422 PERIOD_LOCKED` if the covering period is closed/locked.

---

## 7.8 Journals

Base path: `/api/v1/journals` 

Enforces **double-entry bookkeeping**: debits must equal credits, checked both before the request reaches the database and independently by the database itself. **Posted journals are immutable** — the only correction mechanism is reversal.

---

### `POST /journals` 

```json
{
  "clientUuid": "550e8400-e29b-41d4-a716-446655440099",
  "date": "2026-09-15",
  "currency": "KES",
  "description": "Cash sale",
  "source": "CASHBOOK",
  "lines": [
    { "accountId": "541a185a-c76b-4e0a-9f0e-df5772307a74", "debitMinor": 100000, "creditMinor": 0 },
    { "accountId": "e5f2cf8a-4f7d-4a10-a807-66deb74ac350", "debitMinor": 0, "creditMinor": 100000 }
  ]
}
```

A journal is always created directly with `status: "POSTED"`.

A line may optionally carry `customerId` **or** `supplierId` (never both) to attribute it to a customer's/supplier's subledger balance — see [7.5 Customers](#75-customers) / [7.6 Suppliers](#76-suppliers). For example, a credit sale debits Accounts Receivable with `customerId` set and credits Sales:
```json
{ "accountId": "<ar-account-id>", "debitMinor": 100000, "creditMinor": 0, "customerId": "<customer-id>" }
```

**Error Response:** `422 JOURNAL_UNBALANCED` — with the exact imbalance identified in `detail`. Also `404 ACCOUNT_NOT_FOUND`, `404 CUSTOMER_NOT_FOUND`, `404 SUPPLIER_NOT_FOUND`, `404 PERIOD_NOT_FOUND`, `422 PERIOD_LOCKED`, `422 ACCOUNT_INACTIVE`/`ACCOUNT_NOT_POSTABLE`/`JOURNAL_LINE_AMBIGUOUS`/`JOURNAL_LINE_EMPTY`/`CURRENCY_MISMATCH` as appropriate, `400 VALIDATION_ERROR` if a line carries both `customerId` and `supplierId`.

### `GET /journals` / `GET /journals/{id}` 

List (no lines) / get (with lines).

### `POST /journals/{id}/reverse` 

Creates a **new** journal with every line's debit/credit swapped, dated today, referencing the original. **The original is left completely unchanged** — the link is one-directional (reversal → original only). `422 JOURNAL_ALREADY_REVERSED` if already reversed.

### Notes for consuming clients (Journals)

- Always generate a fresh `clientUuid` per journal.
- Parse `debit_minor`/`credit_minor` as strings, not numbers.
- A journal can only be reversed once.
- Create at least one open period before attempting to post journals.

---

## 7.9 Credit Sales

Base path: `/api/v1/credit-sales` 

Guided endpoint for the most common transaction of all: selling on credit. Instead of hand-building a balanced journal, send the invoice shape and the server composes it — standard double-entry for a sales invoice:

```
Dr Accounts Receivable   (gross = net + tax)
    Cr Revenue line(s)   (net, one per line)
    Cr Tax Payable       (if any tax)
```

---

### `POST /credit-sales` 

```json
{
  "clientUuid": "550e8400-e29b-41d4-a716-446655440100",
  "customerId": "9a2f3e6c-4a2b-4c1a-9c1a-4a2b4c1a9c1a",
  "receivableAccountId": "541a185a-c76b-4e0a-9f0e-df5772307a74",
  "date": "2026-09-15",
  "currency": "KES",
  "reference": "INV-0001",
  "lines": [
    { "incomeAccountId": "e5f2cf8a-4f7d-4a10-a807-66deb74ac350", "amountMinor": 100000, "narrative": "Goods sold" }
  ],
  "taxAccountId": "3f6c1a4a-2b4c-4c1a-9c1a-4a2b4c1a9c1b",
  "taxAmountMinor": 16000
}
```

- `lines` takes one entry per revenue line (e.g. goods vs. delivery service) — at least one is required. `amountMinor` on each is the **net** amount; the server sums them for the revenue side.
- `taxAccountId`/`taxAmountMinor` are both optional, but `taxAccountId` is **required** whenever `taxAmountMinor > 0` (`400 VALIDATION_ERROR` otherwise). Kenya's standard VAT rate is 16% — e.g. for a KES 1,000.00 net sale, `taxAmountMinor: 16000`.
- The response is a full `Journal` (same shape as `POST /journals`), with `source: "SALE"` and one line per: AR (debit, `customerId` tagged), each revenue line (credit), and tax (credit, if present).
- `description` defaults to `"Credit sale"` if omitted.
- Posts through the exact same pipeline as `POST /journals` — period, account, and customer-attribution checks all apply identically, so the same error codes surface: `404 CUSTOMER_NOT_FOUND` / `ACCOUNT_NOT_FOUND` / `PERIOD_NOT_FOUND`, `422 PERIOD_LOCKED` / `ACCOUNT_INACTIVE` / `ACCOUNT_NOT_POSTABLE`.

### Notes for consuming clients (Credit Sales)

- This is a convenience wrapper, not a separate ledger concept — the resulting journal shows up in `GET /journals` and counts toward the customer's `balance_minor` exactly like a hand-built one.
- There is no guided "Write Bill"/"Write Cheque" endpoint yet — those still go through `POST /journals` directly.

---

## 7.10 Cash Sales

Base path: `/api/v1/cash-sales` 

Guided endpoint for a sale paid immediately — no customer, no Accounts Receivable. Standard double-entry for a cash sale:

```
Dr Cash/Bank             (gross = net + tax)
    Cr Revenue line(s)   (net, one per line)
    Cr Tax Payable       (if any tax)
```

---

### `POST /cash-sales` 

```json
{
  "clientUuid": "550e8400-e29b-41d4-a716-446655440101",
  "receivedAccountId": "1a2b3c4d-5e6f-4a10-9c1a-4a2b4c1a9c1a",
  "date": "2026-09-15",
  "currency": "KES",
  "reference": "RCT-0001",
  "lines": [
    { "incomeAccountId": "e5f2cf8a-4f7d-4a10-a807-66deb74ac350", "amountMinor": 50000, "narrative": "Goods sold" }
  ],
  "taxAccountId": "3f6c1a4a-2b4c-4c1a-9c1a-4a2b4c1a9c1b",
  "taxAmountMinor": 8000
}
```

- Same `lines` / `taxAccountId` / `taxAmountMinor` rules as [7.9 Credit Sales](#79-credit-sales) — at least one revenue line required, `taxAccountId` required whenever `taxAmountMinor > 0`.
- No `customerId` field exists here at all — a cash sale never touches a customer's AR subledger, since nothing is owed.
- The response is a full `Journal`, with `source: "CASHBOOK"` (the same source manual cash-receipt entries use) and one line per: Cash/Bank (debit), each revenue line (credit), and tax (credit, if present).
- `description` defaults to `"Cash sale"` if omitted.
- Same error codes as Credit Sale, minus anything customer-related: `404 ACCOUNT_NOT_FOUND` / `PERIOD_NOT_FOUND`, `422 PERIOD_LOCKED` / `ACCOUNT_INACTIVE` / `ACCOUNT_NOT_POSTABLE`.

### Notes for consuming clients (Cash Sales)

- There is no guided "Write Bill"/"Write Cheque" endpoint yet — those still go through `POST /journals` directly.
