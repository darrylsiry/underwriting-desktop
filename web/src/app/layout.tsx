import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { setUserAction } from "./submissions/actions";
import { currentUser } from "@/lib/user";
import "./globals.css";

const RATING_ADMIN_URL = process.env.RATING_ADMIN_URL ?? "http://localhost:8001/admin";

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
  const user = await currentUser();
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-200 bg-white px-6 py-3 text-sm">
          <Link href="/" className="whitespace-nowrap font-semibold">Underwriting Desktop</Link>
          <nav className="flex gap-4 whitespace-nowrap text-slate-600">
            <Link href="/insureds" className="hover:text-slate-900">Customers</Link>
            <Link href="/submissions" className="hover:text-slate-900">Submissions</Link>
            <Link href="/quotes" className="hover:text-slate-900">Quotes</Link>
            <Link href="/policies" className="hover:text-slate-900">Policies</Link>
            <Link href="/audit" className="hover:text-slate-900">Audit</Link>
            <a href={RATING_ADMIN_URL} className="hover:text-slate-900">Rate tables</a>
          </nav>
          <form action="/search" className="ml-auto">
            <input name="q" placeholder="Search insureds, SUB-, Q-, GL-…" aria-label="Search"
              className="w-44 rounded border border-slate-300 px-2 py-1 text-slate-900 lg:w-64" />
          </form>
          <form action={setUserAction} className="flex items-center gap-2 text-slate-500">
            <label htmlFor="uw-name" className="sr-only whitespace-nowrap xl:not-sr-only">Working as</label>
            <input id="uw-name" name="name" defaultValue={user} size={12}
              className="rounded border border-slate-300 px-2 py-1 text-slate-900" />
            <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">Set</button>
          </form>
        </header>
        {children}
      </body>
    </html>
  );
}
