// The issue-a-quote form, shared by the workbench and the renewal comparison page.
export function IssueQuoteForm({ action, effective, expiration, subjectivities, label }: {
  action: (form: FormData) => Promise<void>; effective: string; expiration: string; subjectivities: string[]; label: string;
}) {
  return (
    <form action={action} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-500">Effective
          <input name="effective_date" defaultValue={effective} placeholder="YYYY-MM-DD" required className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">Expiration
          <input name="expiration_date" defaultValue={expiration} placeholder="YYYY-MM-DD" className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-900" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-slate-500">Subjectivities (one per line)
        <textarea name="subjectivities" rows={4} defaultValue={subjectivities.join("\n")} className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-900" />
      </label>
      <button className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500">{label}</button>
    </form>
  );
}
