// Access requests from the signed-out sign-in page (step 27): what a request must contain, the
// throttle, and the email the owner receives. Pure, so node:test drives it; the action stores
// the request, then sends the email through lib/mailer.ts.

import { addressKey } from "./login-meta.ts";
import { when } from "./time.ts";

/** Where requests go unless ACCESS_REQUEST_TO says otherwise. */
export const ACCESS_REQUEST_TO = "darryl@siryous.com";

/** A public form that sends email: at most this many from one network an hour, and emails to the owner a day. */
export const LIMITS = { perAddressPerHour: 3, emailsPerDay: 30 };

/** Recorded instead of sending once the day's emails are used up; the request itself is kept. */
export const DAILY_MAIL_CAP = "daily mail cap";

export type AccessRequestInput = { name: string; email: string; company: string };
export type AccessRequestErrors = Partial<Record<keyof AccessRequestInput, string>>;

// A plain address only: no quotes, comments, angle brackets, commas or semicolons, so nothing a
// mail library's address parser could read as a second recipient, and no ? & = % that would mean
// something in a mailto: link (CR-098).
const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

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

/**
 * What happens to a request, from what is already on file. Too many from the sender's own network
 * (an IPv6 /64 counts as one) and it is refused. Once the day's emails are used up it is still kept
 * and the requester still hears "sent", so one sender filling the cap can't turn real people away:
 * the owner finds them under Admin → Sign-ins.
 */
export function admission(ip: string | null, recent: { addressesLastHour: (string | null)[]; emailsLastDay: number }): { refused: string | null; email: boolean } {
  const network = addressKey(ip);
  if (recent.addressesLastHour.filter((a) => addressKey(a) === network).length >= LIMITS.perAddressPerHour) {
    return { refused: "There have been several requests from your network in the last hour. Please try again later.", email: false };
  }
  return { refused: null, email: recent.emailsLastDay < LIMITS.emailsPerDay };
}

/** A mailto: link to a stored address, whatever it holds: nothing in it can add recipients or a body (CR-098). */
export const mailtoHref = (email: string) => `mailto:${email.split("@").map(encodeURIComponent).join("@")}`;

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
