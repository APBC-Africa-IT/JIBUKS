/**
 * Email sending, via Resend.
 *
 * Deliberately isolated here so the rest of the app never imports Resend
 * directly -- if the provider ever changes, this is the only file that
 * needs to change.
 */

import { Resend } from "resend";

let client: Resend | undefined;

function getClient(): Resend {
  if (!client) {
    const apiKey = process.env["RESEND_API_KEY"];
    if (!apiKey) {
      throw new Error("RESEND_API_KEY is not set");
    }
    client = new Resend(apiKey);
  }
  return client;
}

export interface SendInviteEmailInput {
  readonly to: string;
  readonly tenantName: string;
  readonly inviterName: string;
  readonly acceptUrl: string;
}

export async function sendInviteEmail(input: SendInviteEmailInput): Promise<void> {
  const from = process.env["RESEND_FROM_ADDRESS"];
  if (!from) {
    throw new Error("RESEND_FROM_ADDRESS is not set");
  }

  const result = await getClient().emails.send({
    from,
    to: input.to,
    subject: `You've been invited to join ${input.tenantName} on JiBUks`,
    html: `
      <p>${input.inviterName} has invited you to join <strong>${input.tenantName}</strong> on JiBUks.</p>
      <p><a href="${input.acceptUrl}">Click here to accept the invitation</a></p>
      <p>This link expires in 7 days.</p>
    `,
  });

  if (result.error) {
    // Deliberately does not throw -- see the design note in
    // invites/service.ts on why a failed email must not fail invite
    // creation. Logged so it's visible in server logs for follow-up.
    console.error("Failed to send invite email:", result.error);
  }
}