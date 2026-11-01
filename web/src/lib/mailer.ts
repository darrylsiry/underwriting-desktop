// Outgoing email (step 27). Mail goes out through one SMTP server named by SMTP_URL, for example
// smtps://darryl%40siryous.com:<app password>@smtp.gmail.com:465 (Google Workspace) or
// smtps://resend:<api key>@smtp.resend.com:465. Unset, mail is off: sendMail says so and the
// caller keeps what it would have sent. The password lives only in that secret, never in a log.

import nodemailer from "nodemailer";

type Env = Record<string, string | undefined>;
type Address = string | { name: string; address: string };
export type Message = { to: Address; replyTo?: Address; subject: string; text: string };
export type SendResult = { sent: true; id: string } | { sent: false; reason: string };

type Transport = { sendMail(m: { from: string; to: Address; replyTo?: Address; subject: string; text: string }): Promise<{ messageId?: string }> };
type CreateTransport = (options: { url: string; connectionTimeout: number; greetingTimeout: number; socketTimeout: number }) => Transport;

export const mailConfigured = (env: Env = process.env) => Boolean(env.SMTP_URL?.trim());

/** The sender: MAIL_FROM, else the SMTP login when it is an address (Gmail sends only as the account it logs in as). */
export function senderOf(env: Env = process.env): string {
  if (env.MAIL_FROM?.trim()) return env.MAIL_FROM.trim();
  try {
    const user = decodeURIComponent(new URL(env.SMTP_URL ?? "").username);
    if (/^[^@\s]+@[^@\s]+$/.test(user)) return `Underwriting Desktop <${user}>`;
  } catch {
    // not a URL: fall through
  }
  return "Underwriting Desktop <no-reply@localhost>";
}

/** An error's message with any credentials in a URL blanked, short enough to store. */
export const describeMailError = (err: unknown) =>
  `${(err as { code?: string }).code ? `${(err as { code: string }).code}: ` : ""}${(err as Error)?.message ?? String(err)}`
    .replace(/\/\/[^\s/@]*@/g, "//***@").replace(/\s+/g, " ").slice(0, 300);

/** Send one plain-text email. Never throws: the result says whether it went and why not. */
export async function sendMail(m: Message, env: Env = process.env, create: CreateTransport = nodemailer.createTransport as unknown as CreateTransport): Promise<SendResult> {
  const url = env.SMTP_URL?.trim();
  if (!url) return { sent: false, reason: "Email is not set up: SMTP_URL is not configured" };
  try {
    // Short timeouts: the person waiting on the form should hear back in seconds either way.
    const transport = create({ url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
    const info = await transport.sendMail({ from: senderOf(env), to: m.to, replyTo: m.replyTo, subject: m.subject, text: m.text });
    return { sent: true, id: info.messageId ?? "" };
  } catch (err) {
    return { sent: false, reason: describeMailError(err) };
  }
}
