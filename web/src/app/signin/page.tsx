import { redirect } from "next/navigation";
import { loadUsers } from "@/lib/basic-auth";
import { signedInUser } from "@/lib/user";
import { safeNext, signInAction } from "./actions";

export const dynamic = "force-dynamic";

type Params = { next?: string; error?: string; username?: string; signedout?: string };

/** The sign-in page: the underwriter logins, on a page of the app's own instead of the browser's prompt. */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  if (!loadUsers(process.env).size) redirect("/");          // no gate locally: nothing to sign in to
  const next = await safeNext(p.next);
  if (await signedInUser()) redirect(next);                   // already in
  return (
    <main className="flex min-h-[calc(100vh-1px)] items-center justify-center bg-slate-50 px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white shadow-sm">UW</div>
          <h1 className="text-xl font-semibold text-slate-900">Underwriting Desktop</h1>
          <p className="mt-1 text-sm text-slate-500">E&amp;S Contractors General Liability</p>
        </div>
        <form action={signInAction} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <input type="hidden" name="next" value={next} />
          {p.signedout && <p className="mb-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">You&apos;re signed out.</p>}
          {p.error && <p className="mb-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">That user ID or password isn&apos;t right.</p>}
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500" htmlFor="username">User ID</label>
          <input id="username" name="username" autoComplete="username" autoFocus required defaultValue={p.username ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200" />
          <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-500" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200" />
          <button className="mt-6 w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Sign in</button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-500">Logins are issued per underwriter. Other systems use the same logins with HTTP Basic authentication on the API.</p>
      </div>
    </main>
  );
}
