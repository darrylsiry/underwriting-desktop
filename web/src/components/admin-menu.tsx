"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type AdminItem = { href: string; label: string; external?: boolean };

/**
 * The "Admin" drop-down in the top nav: the back-office pages (audit trail, accounting, rate
 * tables) behind one item. Opens on click, closes on Escape, on a click elsewhere, or when the
 * route changes; the button shows as current when one of its pages is open. Labels only: the
 * pages explain themselves.
 */
export function AdminMenu({ items }: { items: AdminItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const current = items.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        className={`flex items-center gap-1 hover:text-slate-900 ${current ? "font-medium text-slate-900" : ""}`}>
        Admin <span aria-hidden className={`text-[10px] transition ${open ? "rotate-180" : ""}`}>▼</span>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-20 mt-2 w-40 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {items.map((i) => {
            const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
            const cls = `block whitespace-nowrap px-3 py-2 hover:bg-slate-50 ${active ? "bg-indigo-50/60 font-medium text-indigo-700" : "text-slate-700"}`;
            return i.external
              ? <a key={i.href} href={i.href} role="menuitem" className={cls}>{i.label}</a>
              : <Link key={i.href} href={i.href} role="menuitem" className={cls} onClick={() => setOpen(false)}>{i.label}</Link>;
          })}
        </div>
      )}
    </div>
  );
}
