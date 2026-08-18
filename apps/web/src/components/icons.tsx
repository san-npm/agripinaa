import type { Category } from "@agripinaa/agent-index";

type IconProps = { className?: string };

const base = "h-full w-full";

export function GridIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? base} aria-hidden>
      <path d="M4 8h16M4 16h16M9 4v16M15 4v16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
export function ShieldIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? base} aria-hidden>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function YieldIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? base} aria-hidden>
      <path d="M4 15l5-5 4 4 7-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 6v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function RangeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? base} aria-hidden>
      <path d="M6 4v16M18 4v16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
export function VerifiedIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? base} aria-hidden>
      <path d="M12 2l2.4 1.8 3-.2.6 2.9 2.4 1.8-1.2 2.7 1.2 2.7-2.4 1.8-.6 2.9-3-.2L12 22l-2.4-1.8-3 .2-.6-2.9L3.6 15.7l1.2-2.7-1.2-2.7 2.4-1.8.6-2.9 3 .2L12 2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function ReceiptIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? base} aria-hidden>
      <path d="M6 3h12v18l-2-1.2L14 21l-2-1.2L10 21l-2-1.2L6 21V3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
export function ArrowIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? base} aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const CATEGORY_ICON: Record<Category, (p: IconProps) => React.ReactNode> = {
  grid: GridIcon,
  "health-factor": ShieldIcon,
  yield: YieldIcon,
  rebalancing: RangeIcon,
};
