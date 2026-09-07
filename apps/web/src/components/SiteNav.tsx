'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef } from 'react';

const links = [
  ['/agents', 'Explore agents'], ['/proof', 'Activity'],
  ['/leaderboard', 'Performance'], ['/funds', 'Security'],
] as const;

export function SiteNav() {
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  const active = (href: string) => pathname === href || (href === '/agents' && /^\/(agent|c)\//.test(pathname));
  function close() { if (menu.current) menu.current.open = false; }
  const items = links.map(([href, label]) => (
    <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined} onClick={close}>{label}</Link>
  ));
  return (
    <>
      <div className="nav-links desktop-nav">{items}</div>
      <Link href="/dashboard" className="button-primary nav-account" aria-current={pathname === '/dashboard' ? 'page' : undefined}>My agents</Link>
      <details ref={menu} className="mobile-nav" onKeyDown={(event) => {
        if (event.key === 'Escape') { close(); menu.current?.querySelector('summary')?.focus(); }
      }}>
        <summary><span className="sr-only">Menu</span><svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
        <div className="nav-links">{items}<Link href="/dashboard" onClick={close} aria-current={pathname === '/dashboard' ? 'page' : undefined}>My agents</Link></div>
      </details>
    </>
  );
}
