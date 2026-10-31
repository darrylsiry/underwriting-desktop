import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { AdminMenu } from "@/components/admin-menu";
import { setUserAction } from "./submissions/actions";
import { loadUsers } from "@/lib/basic-auth";
import { currentUser, signedInUser } from "@/lib/user";
import "./globals.css";

// Rate admin is proxied through this app (src/app/admin) so it shares the password gate.
const RATING_ADMIN_URL = process.env.RATING_ADMIN_URL ?? "/admin";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Underwriting Desktop",
  description: "E&S contractors GL underwriting workbench",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [user, signedIn] = await Promise.all([currentUser(), signedInUser()]);
  // With the gate on, the only page an unsigned visitor sees is /signin: no header chrome there.
  const chrome = signedIn !== null || !loadUsers(process.env).size;
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {chrome && <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-200 bg-white px-6 py-3 text-sm">
          <Link href="/" className="whitespace-nowrap font-semibold">Underwriting Desktop</Link>
          <nav className="flex gap-4 whitespace-nowrap text-slate-600">
            <Link href="/insureds" className="hover:text-slate-900">Customers</Link>
            <Link href="/submissions" className="hover:text-slate-900">Submissions</Link>
            <Link href="/quotes" className="hover:text-slate-900">Quotes</Link>
            <Link href="/policies" className="hover:text-slate-900">Policies</Link>
            <Link href="/assistant" className="hover:text-slate-900">AI Assistant</Link>
            <AdminMenu items={[
              { href: "/audit", label: "Audit" },
              { href: "/audit/logins", label: "Sign-ins" },
              { href: "/accounting", label: "Accounting" },
              { href: RATING_ADMIN_URL, label: "Rate tables", external: true },
            ]} />
          </nav>
          <form action="/search" className="ml-auto">
            <input name="q" placeholder="Search insureds, SUB-, Q-, GL-…" aria-label="Search"
              className="w-44 rounded border border-slate-300 px-2 py-1 text-slate-900 lg:w-64" />
          </form>
          {signedIn ? (
            <span className="flex flex-col items-end whitespace-nowrap leading-tight text-slate-500">
              <span>Signed in as <span className="font-medium text-slate-900">{signedIn}</span></span>
              {/* A POST, so a cross-site image or link can't end the session (CR-081). */}
              <form method="post" action="/signout"><button className="text-xs text-indigo-600 hover:underline">Sign out</button></form>
            </span>
          ) : (
            <form action={setUserAction} className="flex items-center gap-2 text-slate-500">
              <label htmlFor="uw-name" className="sr-only whitespace-nowrap xl:not-sr-only">Working as</label>
              <input id="uw-name" name="name" defaultValue={user} size={12}
                className="rounded border border-slate-300 px-2 py-1 text-slate-900" />
              <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">Set</button>
            </form>
          )}
        </header>}
        {children}
      </body>
    </html>
  );
}
