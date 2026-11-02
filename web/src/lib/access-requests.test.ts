import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCESS_REQUEST_TO, accessRequestEmail, admission, LIMITS, mailtoHref, readAccessRequest } from "./access-requests.ts";
import { describeMailError, sendMail, senderOf } from "./mailer.ts";

const form = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });

test("a request needs a name and a plain email address; company is optional", () => {
  const ok = readAccessRequest(form({ name: "  Pat  Lee ", email: "pat.lee+uw@broker.example.com", company: "" }));
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.input, { name: "Pat Lee", email: "pat.lee+uw@broker.example.com", company: "" });
  assert.deepEqual(Object.keys(readAccessRequest(form({})).errors).sort(), ["email", "name"]);
  for (const bad of ["pat", "pat@", "@x.com", "pat@x", "a b@x.com", "\"x\"@x.com", "pat@x.com, eve@evil.example", "pat@x.com;eve@evil.example",
    "Pat <pat@x.com>", "pat(c)@x.com", "pat@-x.com", "a?cc=b@c.com", "a&body=x@c.com", "a=b@c.com", "a%40b@c.com", "o'brien@c.com", "a/b@c.com"]) {
    assert.ok(readAccessRequest(form({ name: "Pat", email: bad })).errors.email, `refused: ${bad}`);
  }
});

test("line breaks and control characters never reach a header; long values are capped", () => {
  const r = readAccessRequest(form({ name: "Pat\r\nBcc: eve@evil.example", email: "pat@x.com", company: "Acme\nInc\u0000" }));
  assert.equal(r.input.name, "Pat Bcc: eve@evil.example");
  assert.equal(r.input.company, "Acme Inc");
  assert.equal(readAccessRequest(form({ name: "x".repeat(500), email: "p@x.com" })).input.name.length, 100);
  const mail = accessRequestEmail({ ...r.input, at: new Date("2026-11-01T03:30:00Z"), ip: "203.0.113.9", origin: "https://uwdesktop.siryous.app" });
  assert.ok(!/[\r\n]/.test(mail.subject));
});

test("the throttle: a few an hour from one network; past the day's emails a request is kept, not refused (CR-098)", () => {
  const ip = "203.0.113.9";
  const from = (n: number, a: string | null = ip) => Array<string | null>(n).fill(a);
  assert.deepEqual(admission(ip, { addressesLastHour: from(2), emailsLastDay: 29 }), { refused: null, email: true });
  const limited = admission(ip, { addressesLastHour: from(3), emailsLastDay: 3 });
  assert.match(limited.refused ?? "", /last hour/);
  assert.equal(limited.email, false);
  assert.deepEqual(admission(ip, { addressesLastHour: from(40, "198.51.100.1"), emailsLastDay: 2 }), { refused: null, email: true }, "another sender doesn't count against this one");
  assert.deepEqual(admission(ip, { addressesLastHour: [], emailsLastDay: LIMITS.emailsPerDay }), { refused: null, email: false }, "one sender filling the cap can't turn a real person away");
});

test("an IPv6 sender can't rotate through its /64 past the limit (CR-098)", () => {
  const block = ["2600:1702:82d0:bcf::1", "2600:1702:82d0:bcf:aaaa::2", "2600:1702:82d0:0bcf:b50c:5cac:848d:9d45"];
  assert.match(admission("2600:1702:82d0:bcf::ffff", { addressesLastHour: block, emailsLastDay: 0 }).refused ?? "", /last hour/);
  assert.equal(admission("2600:1702:82d0:bd0::1", { addressesLastHour: block, emailsLastDay: 0 }).refused, null, "the next /64 is someone else");
  assert.match(admission(null, { addressesLastHour: [null, null, null], emailsLastDay: 0 }).refused ?? "", /last hour/, "with no address on record (local) they share one limit, as before");
});

test("a mailto: link can't pick up extra recipients or a body from a stored address (CR-098)", () => {
  assert.equal(mailtoHref("pat.lee+uw@broker.example.com"), "mailto:pat.lee%2Buw@broker.example.com");
  assert.equal(mailtoHref("a?cc=b@c.com"), "mailto:a%3Fcc%3Db@c.com", "a row stored before the stricter check");
  assert.equal(new URL(mailtoHref("a?cc=b@c.com&body=x")).search, "");
});

test("the owner's email: to the owner, reply goes to the requester, everything they entered", () => {
  const mail = accessRequestEmail({ name: "Pat Lee", email: "pat@broker.example.com", company: "Broker & Co", at: new Date("2026-11-01T03:30:00Z"), ip: "203.0.113.9", origin: "https://uwdesktop.siryous.app" });
  assert.equal(mail.to, ACCESS_REQUEST_TO);
  assert.equal(ACCESS_REQUEST_TO, "darryl@siryous.com");
  assert.deepEqual(mail.replyTo, { name: "Pat Lee", address: "pat@broker.example.com" });
  assert.equal(mail.subject, "Access request: Pat Lee (Broker & Co)");
  for (const s of ["Name:     Pat Lee", "Email:    pat@broker.example.com", "Company:  Broker & Co", "Address:  203.0.113.9", "https://uwdesktop.siryous.app/request-access", "scripts/fly-users.sh"]) {
    assert.ok(mail.text.includes(s), s);
  }
  const noCompany = accessRequestEmail({ name: "Pat", email: "p@x.com", company: "", at: new Date(), ip: null, origin: "http://localhost:3100" }, "ops@example.test");
  assert.equal(noCompany.subject, "Access request: Pat");
  assert.equal(noCompany.to, "ops@example.test");
  assert.ok(noCompany.text.includes("Company:  (not given)") && noCompany.text.includes("Address:  not recorded"));
});

test("the mailer: off without SMTP_URL, sends from the login it uses, never throws or leaks the password", async () => {
  const msg = { to: "darryl@siryous.com", replyTo: { name: "Pat", address: "p@x.com" }, subject: "s", text: "t" };
  assert.deepEqual(await sendMail(msg, {}), { sent: false, reason: "Email is not set up: SMTP_URL is not configured" });

  const env = { SMTP_URL: "smtps://darryl%40siryous.com:app-password@smtp.gmail.com:465" };
  assert.equal(senderOf(env), "Underwriting Desktop <darryl@siryous.com>");
  assert.equal(senderOf({ ...env, MAIL_FROM: "Desk <desk@siryous.com>" }), "Desk <desk@siryous.com>");
  assert.equal(senderOf({ SMTP_URL: "smtps://resend:key@smtp.resend.com:465" }), "Underwriting Desktop <no-reply@localhost>");

  let opened: { url: string; connectionTimeout: number } | undefined, sent: unknown;
  const ok = await sendMail(msg, env, (o) => { opened = o; return { sendMail: async (m) => { sent = m; return { messageId: "<1@x>" }; } }; });
  assert.deepEqual(ok, { sent: true, id: "<1@x>" });
  assert.equal(opened?.url, env.SMTP_URL);
  assert.ok(opened!.connectionTimeout <= 10_000, "the form never waits long on a dead server");
  assert.deepEqual(sent, { from: "Underwriting Desktop <darryl@siryous.com>", ...msg });

  const failed = await sendMail(msg, env, () => ({ sendMail: async () => { throw Object.assign(new Error("Invalid login for smtps://darryl%40siryous.com:app-password@smtp.gmail.com"), { code: "EAUTH" }); } }));
  assert.equal(failed.sent, false);
  assert.ok(!JSON.stringify(failed).includes("app-password"), "the password never reaches the stored reason");
  assert.match((failed as { reason: string }).reason, /^EAUTH: Invalid login for smtps:\/\/\*\*\*@smtp\.gmail\.com/);
  assert.equal(describeMailError("plain"), "plain");
});
