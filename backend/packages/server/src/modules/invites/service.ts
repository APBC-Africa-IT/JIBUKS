/**
 * Invites service -- the public interface of this module.
 */

import { randomBytes, createHash } from "node:crypto";
import { DomainError } from "@jibuks/domain";
import type { AuditContext } from "@jibuks/db";
import * as repository from "./repository.js";
import type { InviteRow } from "./repository.js";
import * as usersService from "../users/service.js";
import { sendInviteEmail } from "../../email/resend.js";

const INVITE_EXPIRY_DAYS = 7;

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function acceptUrl(token: string): string {
  const base = process.env["INVITE_ACCEPT_BASE_URL"] ?? "https://dev-jibuksapi.apbcafrica.com/accept-invite";
  return `${base}?token=${token}`;
}

export interface CreateInviteRequest {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly email: string;
  readonly name?: string;
}

export async function createInvite(request: CreateInviteRequest, audit: AuditContext): Promise<Omit<InviteRow, "token_hash">> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const invite = await repository.createInvite(
    {
      tenantId: request.tenantId,
      email: request.email,
      ...(request.name !== undefined ? { name: request.name } : {}),
      tokenHash,
      expiresAt,
    },
    audit,
  );

  const inviter = await usersService.getUser(request.tenantId, audit.actorUserId);

  // Deliberately NOT awaited-and-thrown-on-failure: the invite itself is
  // already committed by the time we get here. If the email fails to send
  // (Resend outage, bad address, etc.), the invite row still exists and is
  // still valid -- losing the notification is recoverable (resend later),
  // losing the invite record itself would not be.
  await sendInviteEmail({
    to: request.email,
    tenantName: request.tenantName,
    inviterName: inviter.name,
    acceptUrl: acceptUrl(token),
  });

  const { token_hash, ...safeInvite } = invite;
  return safeInvite;
}

export async function listInvites(tenantId: string): Promise<Omit<InviteRow, "token_hash">[]> {
  const invites = await repository.listInvites(tenantId);
  return invites.map(({ token_hash, ...safeInvite }) => safeInvite);
}

export interface InvitePreview {
  readonly tenantName: string;
  readonly inviterName: string;
  readonly status: InviteRow["status"];
  readonly expired: boolean;
}

/** Used by GET /invites/{token} -- shown to the invitee BEFORE they log in. */
export async function previewInvite(token: string): Promise<InvitePreview> {
  const invite = await repository.findInviteByTokenHash(hashToken(token));
  if (!invite) {
    throw new DomainError("USER_NOT_FOUND", "Invite not found");
  }

  // These two lookups intentionally go through the SAME auth-resolver path
  // as the invite itself -- the tenant/inviter names are being shown to
  // someone with no tenant context, exactly like the invite record itself.
  const tenantName = await repository.getTenantNameForInvite(invite.tenant_id);
  const inviterName = await repository.getInviterNameForInvite(invite.invited_by);

  return {
    tenantName,
    inviterName,
    status: invite.status,
    expired: new Date(invite.expires_at) < new Date(),
  };
}

export async function acceptInvite(
  token: string,
  externalIdpSubject: string,
  name: string,
): Promise<{ tenantId: string; userId: string }> {
  const invite = await repository.findInviteByTokenHash(hashToken(token));
  if (!invite) {
    throw new DomainError("USER_NOT_FOUND", "Invite not found");
  }
  if (invite.status !== "PENDING") {
    throw new DomainError("USER_ALREADY_EXISTS", `This invite is no longer valid (${invite.status.toLowerCase()})`);
  }
  if (new Date(invite.expires_at) < new Date()) {
    throw new DomainError("USER_ALREADY_EXISTS", "This invite has expired");
  }

  // Per the confirmed rule: one Auth0 identity maps to exactly one tenant,
  // permanently -- same check /onboarding performs.
  const existing = await usersService.findByExternalIdpSubject(externalIdpSubject);
  if (existing) {
    throw new DomainError(
      "USER_ALREADY_EXISTS",
      `This identity already has an account (user ${existing.id}, tenant ${existing.tenant_id})`,
    );
  }

  const user = await usersService.createUserFromInvite({
    tenantId: invite.tenant_id,
    externalIdpSubject,
    name,
    email: invite.email,
  });

  await repository.markInviteAccepted(invite.id, user.id);

  return { tenantId: invite.tenant_id, userId: user.id };
}