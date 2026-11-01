import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { RowLink } from "@/components/ui";
import { readReport } from "@/lib/agent-activity";
import { AGENTS } from "@/lib/agent-reports";
import { when } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ agent: string }> }): Promise<Metadata> {
  const { agent } = await params;
  const info = AGENTS.find((a) => a.key === agent);
  return { title: info ? `${info.name} report` : "Report" };
}

/** One agent's latest report as it wrote it (App Tests → Full report). */
export default async function AgentReportPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  const info = AGENTS.find((a) => a.key === agent);
  if (!info) notFound();
  const report = await readReport(info.key);
  if (!report) notFound();
  return (
    <main className="mx-auto max-w-5xl p-6 lg:p-8">
      <RowLink href={`/app-tests?agent=${info.key}#findings`}>← App Tests</RowLink>
      <p className="mt-2 text-xs text-slate-500">
        <code className="rounded bg-slate-100 px-1">docs/{info.file}</code> as the <code className="rounded bg-slate-100 px-1">{info.agent}</code> agent
        wrote it on its latest run · saved {when(report.mtime)}
      </p>
      <article className="mt-4 min-w-0 overflow-x-auto rounded-lg border border-slate-200 bg-white px-6 py-5 shadow-sm">
        <Markdown source={report.text} />
      </article>
    </main>
  );
}
