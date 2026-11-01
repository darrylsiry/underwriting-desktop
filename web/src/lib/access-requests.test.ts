import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCESS_REQUEST_TO, accessRequestEmail, readAccessRequest, throttled } from "./access-requests.ts";
import { describeMailError, sendMail, senderOf } from "./mailer.ts";

const form = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });

test("a request needs a name and a plain email address; company is optional", () => {
  const ok = readAccessRequest(form({ name: "  Pat  Lee ", email: "pat.lee+uw@broker.example.com", company: "" }));
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.input, { name: "Pat Lee", email: "pat.lee+uw@broker.example.com", company: "" });
  assert.deepEqual(Object.keys(readAccessRequest(form({})).errors).sort(), ["email", "name"]);
  for (const bad of ["pat", "pat@", "@x.com", "pat@x", "a b@x.com", "\"x\"@x.com", "pat@x.com, eve@evil.example", "pat@x.com;eve@evil.example",
    "Pat <pat@x.com>", "pat(c)@x.com", "pat@-x.com"]) {
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

test("the throttle: a few an hour from one address, a cap a day in all", () => {
  assert.equal(throttled({ fromAddressLastHour: 2, lastDay: 29 }), null);
  assert.match(throttled({ fromAddressLastHour: 3, lastDay: 3 }) ?? "", /last hour/);
  assert.match(throttled({ fromAddressLastHour: 0, lastDay: 30 }) ?? "", /tomorrow/);
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
