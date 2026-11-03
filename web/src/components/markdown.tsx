import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";

/** The assistant's Markdown answers, with the app's links as plain anchors (relative paths stay in the app). */
export function Markdown({ source }: { source: string }) {
  return <div className="space-y-3 text-sm leading-relaxed text-slate-800">{parseMarkdown(source).map((b, i) => <BlockView key={i} b={b} />)}</div>;
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return <>{nodes.map((n, i) => {
    switch (n.type) {
      case "text": return <span key={i}>{n.text}</span>;
      case "strong": return <strong key={i} className="font-semibold text-slate-900"><Inlines nodes={n.children} /></strong>;
      case "em": return <em key={i}><Inlines nodes={n.children} /></em>;
      case "code": return <code key={i} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-800">{n.text}</code>;
      case "link": {
        const external = /^https?:\/\//i.test(n.href);
        return <a key={i} href={n.href} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} className="font-medium text-indigo-600 hover:underline"><Inlines nodes={n.children} /></a>;
      }
    }
  })}</>;
}

function BlockView({ b }: { b: Block }) {
  switch (b.type) {
    case "heading": {
      const Tag = b.level <= 1 ? "h2" : b.level === 2 ? "h3" : "h4";   // a level below the page's own h1
      const cls = b.level <= 1 ? "text-lg" : b.level === 2 ? "text-base" : "text-sm";
      return <Tag className={`${cls} mt-1 font-semibold text-slate-900`}><Inlines nodes={b.children} /></Tag>;
    }
    case "paragraph": return <p><Inlines nodes={b.children} /></p>;
    case "list": {
      const items = b.items.map((it, i) => <li key={i}><Inlines nodes={it} /></li>);
      return b.ordered ? <ol className="list-decimal space-y-1 pl-5">{items}</ol> : <ul className="list-disc space-y-1 pl-5">{items}</ul>;
    }
    case "table": return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>{b.header.map((c, i) => <th key={i} className="border-b border-slate-200 px-2 py-1 font-medium">{<Inlines nodes={c} />}</th>)}</tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => <tr key={i} className="border-b border-slate-100">{r.map((c, j) => <td key={j} className="px-2 py-1 align-top">{<Inlines nodes={c} />}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    );
    case "code": return <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100"><code>{b.text}</code></pre>;
    case "quote": return <blockquote className="border-l-2 border-slate-300 pl-3 text-slate-600"><Inlines nodes={b.children} /></blockquote>;
    case "rule": return <hr className="border-slate-200" />;
  }
}
