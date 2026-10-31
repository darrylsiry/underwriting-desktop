"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * A main-nav link that knows when its section is open (UX-010): `aria-current="page"` and the
 * same emphasis the Admin menu already gives its current page. A section is current for its own
 * path and everything under it (/quotes/… lights up Quotes).
 */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const current = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={current ? "page" : undefined} className={`hover:text-slate-900 ${current ? "font-medium text-slate-900" : ""}`}>
      {children}
    </Link>
  );
}
