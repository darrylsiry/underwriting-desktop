import type { Metadata } from "next";
import Link from "next/link";
import { RequestAccessForm } from "./request-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Request access" };

/** Ask for a login (step 27), linked from the sign-in page and reachable signed out. */
export default function RequestAccessPage() {
  return (
    <main className="flex min-h-[calc(100vh-1px)] items-center justify-center bg-slate-50 px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white shadow-sm">UW</div>
          <h1 className="text-xl font-semibold text-slate-900">Request access</h1>
          <p className="mt-1 text-sm text-slate-500">Underwriting Desktop · E&amp;S Contractors General Liability</p>
        </div>
        <RequestAccessForm />
        <p className="mt-4 text-center text-sm"><Link href="/signin" className="text-indigo-600 hover:underline">← Back to sign in</Link></p>
      </div>
    </main>
  );
}
