import { headers } from "next/headers";
import Link from "next/link";
import { Card, Code, Crumbs, Json, Method, btn, btnPrimary } from "@/components/docs";
import { loadUsers } from "@/lib/basic-auth";
import { GL_TIME_ZONE, PERIOD_PRESETS, PRESET_LABEL, TRANSACTION_LABEL, glDate, presetRange } from "@/lib/gl-journal";
import { glOpenApi, type Operation, type Parameter } from "@/lib/gl-openapi";
import { periodsDocument } from "@/lib/gl-service";
import { requestOrigin } from "@/lib/http";
import { listPostings } from "@/lib/ledger";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

const schemaText = (s: Parameter["schema"]) => [
  s.type, s.format, s.enum ? `one of ${s.enum.join(" | ")}` : null, s.pattern ? `matches ${s.pattern}` : null, s.default ? `default ${s.default}` : null, s.example ? `e.g. ${s.example}` : null,
].filter(Boolean).join(" · ");

/** The GL API's documentation, rendered from the same OpenAPI document the API serves. */
export default async function GlApiDocsPage() {
  const h = await headers();
  const origin = requestOrigin(h);
  const actor = await currentUser();
  const gated = loadUsers(process.env).size > 0;
  const spec = glOpenApi(origin);
  const today = glDate(new Date());
  const [sample, firstJournal] = await Promise.all([periodsDocument({ actor, origin }), listPostings({ from: null, to: null, type: "", batch: "" }).then((r) => r[0]?.journal_no ?? "JE-000001")]);
  const tryHref = (path: string, op: Operation) => {
    const p = path.replace("{journal_no}", firstJournal);
    return op["x-try"] ? `${p}?${op["x-try"]}` : p;
  };
  const curlAuth = gated ? "-u underwriter1 " : "";
  const operations = Object.entries(spec.paths).flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({ path, method, op: op! })));

  return (
    <main className="mx-auto max-w-5xl p-8">
      <Crumbs trail={[{ href: "/accounting", label: "Accounting" }, { label: "API" }]} />
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{spec.info.title} <span className="ml-1 align-middle rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-normal text-slate-600">v{spec.info.version}</span></h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">{spec.info.summary}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/api/gl/openapi.json" target="_blank" rel="noreferrer" className={btnPrimary}>OpenAPI 3.1 (JSON) ↗</a>
          <a href="/api/gl" target="_blank" rel="noreferrer" className={btn}>Try: GET /api/gl ↗</a>
          <Link href="/accounting/mcp" className={btn}>MCP server →</Link>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        <Card title="Base URL and authentication">
          <p>Base URL <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{origin}</code>. Every path below is relative to it.</p>
          {gated ? (
            <p className="mt-2">
              This instance requires an Underwriting Desktop login. Send it with <strong>HTTP Basic authentication</strong>: the same user id and password that
              opened this page. You are signed in as <strong>{actor}</strong>; the API answers as that user (<code className="text-xs">generated_by</code>) and
              records pushes under that name in the audit trail.
            </p>
          ) : (
            <p className="mt-2">
              This instance runs <strong>without the password gate</strong> (local development), so calls need no credentials and are recorded as <strong>{actor}</strong>.
              The deployed app requires an Underwriting Desktop login, sent with <strong>HTTP Basic authentication</strong>: the same user id and password as the web app.
            </p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            In production this would be a client credential or OAuth; the demo reuses the underwriter logins so a call is traceable to a person.
            A missing or wrong login answers <code>401</code> with <code>{"{\"error\":{\"code\":\"unauthorized\",…}}"}</code>.
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Code title="curl (prompts for the password; nothing lands in shell history)">{`curl ${curlAuth}"${origin}/api/gl/postings?period=this_month"`}</Code>
            <Code title="curl: last month as a CSV file">{`curl ${curlAuth}-o gl-last-month.csv \\\n  "${origin}/api/gl/postings?period=last_month&format=csv"`}</Code>
            <Code title="JavaScript">{`const res = await fetch("${origin}/api/gl/summary?period=ytd"${gated ? `, {\n  headers: { Authorization: "Basic " + btoa(\`underwriter1:\${password}\`) },\n}` : ""});\nconst summary = await res.json();`}</Code>
            <Code title="Python">{`import requests\nr = requests.get("${origin}/api/gl/postings",\n                 params={"period": "last_quarter", "type": "renewal"}${gated ? `,\n                 auth=("underwriter1", password)` : ""})\nledger = r.json()`}</Code>
          </div>
        </Card>

        <Card title="Conventions">
          <ul className="list-disc space-y-1 pl-5">
            <li>Amounts are USD with two decimals. Every journal balances: the sum of debits equals the sum of credits, and the document&apos;s totals reconcile against its lines.</li>
            <li>Posting dates and accounting periods (<code className="text-xs">YYYY-MM</code>) follow the books&apos; time zone, {GL_TIME_ZONE}. Timestamps are ISO 8601 in UTC.</li>
            <li>Reads (<code className="text-xs">GET</code>) never change anything. Only <code className="text-xs">POST /api/gl/exports</code> stamps lines as pushed, exactly like the button on the Accounting page.</li>
            <li>Errors are JSON: <code className="text-xs">{"{ \"error\": { \"code\", \"message\", \"details\"? } }"}</code> with status 400 (a parameter), 401 (login) or 404 (no such journal).</li>
            <li>Transaction types: {Object.entries(TRANSACTION_LABEL).map(([k, v]) => <span key={k}><code className="text-xs">{k}</code> ({v}) </span>)}— endorsements and cancellations are reserved for when those workflows exist.</li>
          </ul>
          <p className="mt-3 text-xs text-slate-500">Period presets, as they resolve today ({today}, {GL_TIME_ZONE}):</p>
          <table className="mt-1 w-full text-xs">
            <thead className="text-left text-slate-500"><tr><th className="py-1 pr-3 font-medium">period=</th><th className="py-1 pr-3 font-medium">Meaning</th><th className="py-1 font-medium">Posting dates</th></tr></thead>
            <tbody>
              {PERIOD_PRESETS.map((p) => { const r = presetRange(p, today); return (
                <tr key={p} className="border-t border-slate-100"><td className="py-1 pr-3 font-mono">{p}</td><td className="py-1 pr-3">{PRESET_LABEL[p]}</td>
                  <td className="py-1 font-mono text-slate-600">{p === "custom" ? "from … to (either may be open)" : p === "all" ? "no limit" : `${r.from} to ${r.to}`}</td></tr>
              ); })}
            </tbody>
          </table>
        </Card>

        <Card title="Endpoints">
          <div className="space-y-6">
            {operations.map(({ path, method, op }) => (
              <section key={op.operationId} id={op.operationId} className="rounded-md border border-slate-200">
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
                  <Method m={method} />
                  <code className="text-sm font-semibold">{path}</code>
                  <span className="text-sm text-slate-600">{op.summary}</span>
                  <span className="ml-auto flex items-center gap-2 text-xs">
                    <span className="text-slate-400">{op.tags.join(", ")}</span>
                    {method === "get" && <a href={tryHref(path, op)} target="_blank" rel="noreferrer" className="rounded border border-indigo-200 bg-white px-2 py-0.5 font-medium text-indigo-700 hover:bg-indigo-50">Try it ↗</a>}
                  </span>
                </div>
                <div className="space-y-3 px-3 py-3">
                  <p className="text-slate-700">{op.description}</p>
                  {op.parameters && op.parameters.length > 0 && (
                    <table className="w-full text-xs">
                      <thead className="text-left text-slate-500"><tr><th className="py-1 pr-3 font-medium">Parameter</th><th className="py-1 pr-3 font-medium">In</th><th className="py-1 pr-3 font-medium">Type</th><th className="py-1 font-medium">Description</th></tr></thead>
                      <tbody>
                        {op.parameters.map((p) => (
                          <tr key={p.name} className="border-t border-slate-100 align-top">
                            <td className="py-1 pr-3 font-mono">{p.name}{p.required && <span className="text-rose-600">*</span>}</td>
                            <td className="py-1 pr-3 text-slate-500">{p.in}</td>
                            <td className="py-1 pr-3 text-slate-600">{schemaText(p.schema)}</td>
                            <td className="py-1 text-slate-700">{p.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {op.requestBody && (
                    <div>
                      <p className="text-xs text-slate-500">Request body ({op.requestBody.required ? "required" : "optional"}): {op.requestBody.description}</p>
                      <Code title="example">{`curl ${curlAuth}-X POST "${origin}${path}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(op.requestBody.content["application/json"].example)}'`}</Code>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {Object.entries(op.responses).map(([status, r]) => (
                      <span key={status}><code className={`font-semibold ${status.startsWith("2") ? "text-emerald-700" : "text-rose-700"}`}>{status}</code> {r.description}
                        {r.content && <span className="text-slate-400"> · {Object.keys(r.content).map((c) => c.split(";")[0].replace("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx")).join(", ")}</span>}
                      </span>
                    ))}
                  </div>
                  {method === "get" && <Code title="request">{`GET ${origin}${tryHref(path, op)}`}</Code>}
                </div>
              </section>
            ))}
          </div>
        </Card>

        <Card title="Live sample: GET /api/gl/periods" action={<a href="/api/gl/periods" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">open ↗</a>}>
          <p className="text-xs text-slate-500">Generated just now for this instance, as {actor}.</p>
          <Json value={sample} />
        </Card>

        <Card title="Schemas" action={<a href="/api/gl/openapi.json" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">full document ↗</a>}>
          <div className="space-y-1">
            {Object.entries(spec.components.schemas).map(([name, schema]) => (
              <details key={name} className="rounded border border-slate-100">
                <summary className="cursor-pointer px-3 py-1.5 font-mono text-xs">{name}</summary>
                <div className="px-3 pb-2"><Json value={schema} /></div>
              </details>
            ))}
          </div>
        </Card>
      </div>
    </main>
  );
}
