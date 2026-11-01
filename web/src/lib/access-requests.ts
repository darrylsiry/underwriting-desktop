// Access requests from the signed-out sign-in page (step 27): what a request must contain, the
// throttle, and the email the owner receives. Pure, so node:test drives it; the action stores
// the request, then sends the email through lib/mailer.ts.

import { when } from "./time.ts";

/** Where requests go unless ACCESS_REQUEST_TO says otherwise. */
export const ACCESS_REQUEST_TO = "darryl@siryous.com";

/** A public form that sends email: at most this many from one address an hour, and in all a day. */
export const LIMITS = { perAddressPerHour: 3, perDay: 30 };

export type AccessRequestInput = { name: string; email: string; company: string };
export type AccessRequestErrors = Partial<Record<keyof AccessRequestInput, string>>;

// A plain address only: no quotes, comments, angle brackets, commas or semicolons, so nothing a
// mail library's address parser could read as a second recipient.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** One line of text: control characters (CR and LF among them) become spaces, runs of space collapse, capped. */
const line = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Read and check a submitted form: name and email are required, company is optional. */
export function readAccessRequest(form: { get(name: string): unknown }): { input: AccessRequestInput; errors: AccessRequestErrors } {
  const input = { name: line(form.get("name"), 100), email: line(form.get("email"), 254), company: line(form.get("company"), 120) };
  const errors: AccessRequestErrors = {};
  if (!input.name) errors.name = "Enter your name.";
  if (!input.email) errors.email = "Enter your email address.";
  else if (!EMAIL.test(input.email)) errors.email = "Enter a valid email address, like name@company.com.";
  return { input, errors };
}

/** Why this request can't go through now, or null when it can. */
export function throttled(counts: { fromAddressLastHour: number; lastDay: number }): string | null {
  if (counts.fromAddressLastHour >= LIMITS.perAddressPerHour) return "There have been several requests from your network in the last hour. Please try again later.";
  if (counts.lastDay >= LIMITS.perDay) return "We've had a lot of access requests today. Please try again tomorrow.";
  return null;
}

export type AccessRequestEmail = { to: string; replyTo: { name: string; address: string }; subject: string; text: string };

/** The email to the owner: plain text, with Reply-To set to the requester so a reply goes straight to them. */
export function accessRequestEmail(r: AccessRequestInput & { at: Date; ip: string | null; origin: string }, to: string = ACCESS_REQUEST_TO): AccessRequestEmail {
  const company = r.company || "(not given)";
  return {
    to,
    replyTo: { name: r.name, address: r.email },
    subject: `Access request: ${r.name}${r.company ? ` (${r.company})` : ""}`,
    text: [
      `${r.name} asked for a login to the Underwriting Desktop.`,
      "",
      `Name:     ${r.name}`,
      `Email:    ${r.email}`,
      `Company:  ${company}`,
      `When:     ${when(r.at)}`,
      `Address:  ${r.ip ?? "not recorded"}`,
      `Page:     ${r.origin}/request-access`,
      "",
      "Reply to this email to answer them directly. To give them a login: scripts/fly-users.sh <user id>.",
      `Every request is also listed under Admin → Sign-ins: ${r.origin}/audit/logins`,
    ].join("\n"),
  };
}
