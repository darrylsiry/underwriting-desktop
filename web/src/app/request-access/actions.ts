"use server";

import { headers } from "next/headers";
import { recentRequestCounts, recordEmailResult, storeAccessRequest } from "@/lib/access-request-store";
import { ACCESS_REQUEST_TO, accessRequestEmail, readAccessRequest, throttled, type AccessRequestErrors, type AccessRequestInput } from "@/lib/access-requests";
import { requestOrigin } from "@/lib/http";
import { clientInfo } from "@/lib/login-meta";
import { sendMail } from "@/lib/mailer";

export type RequestState = { sent: boolean; name?: string; email?: string; error?: string; errors?: AccessRequestErrors; values?: AccessRequestInput };

/**
 * A request for a login (step 27): check it, hold back floods, keep it, then email the owner.
 * Kept first, so a request survives mail being off or refused; the owner sees it under
 * Admin → Sign-ins either way. Errors come back in the form state, never in the URL.
 */
export async function requestAccessAction(_prev: RequestState, form: FormData): Promise<RequestState> {
  // The hidden "website" field is for bots: they get the same thanks, and nothing is kept or sent.
  if (String(form.get("website") ?? "").trim()) return { sent: true };
  const { input, errors } = readAccessRequest(form);
  if (Object.keys(errors).length) return { sent: false, errors, values: input };
  const h = await headers();
  const client = clientInfo(h);
  try {
    const limited = throttled(await recentRequestCounts(client.ip));
    if (limited) return { sent: false, error: limited, values: input };
    const id = await storeAccessRequest({ ...input, ip: client.ip, userAgent: client.user_agent });
    const to = process.env.ACCESS_REQUEST_TO?.trim() || ACCESS_REQUEST_TO;
    const result = await sendMail(accessRequestEmail({ ...input, at: new Date(), ip: client.ip, origin: requestOrigin(h) }, to));
    if (!result.sent) console.error(`access-requests: request ${id} kept but not emailed: ${result.reason}`);
    await recordEmailResult(id, result).catch((err) => console.error(`access-requests: request ${id} email result not recorded`, err));
  } catch (err) {
    console.error("access-requests: request not kept", err);
    return { sent: false, error: "Your request couldn't be sent just now. Please try again in a minute.", values: input };
  }
  return { sent: true, name: input.name, email: input.email };
}
