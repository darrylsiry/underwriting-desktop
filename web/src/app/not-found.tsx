import Link from "next/link";

/** The not-found page: an unknown URL, or a submission, quote or policy id that isn't there (CR-027). */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-6xl p-8">
      <section className="mx-auto max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">There&apos;s nothing at this address</h1>
        <p className="mt-2 text-sm text-slate-600">
          The record may have been removed, or the link is wrong. Search by name or reference, or start from your desk.
        </p>
        <form action="/search" className="mt-4 flex gap-2">
          <input name="q" placeholder="Insured, SUB-, Q-, GL-…" aria-label="Search"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900" />
          <button className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Search</button>
        </form>
        <nav className="mt-4 flex gap-4 text-sm">
          <Link href="/" className="text-indigo-600 hover:underline">My desk</Link>
          <Link href="/submissions" className="text-indigo-600 hover:underline">Submissions</Link>
          <Link href="/quotes" className="text-indigo-600 hover:underline">Quotes</Link>
          <Link href="/policies" className="text-indigo-600 hover:underline">Policies</Link>
        </nav>
      </section>
    </main>
  );
}
