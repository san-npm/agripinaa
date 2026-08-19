'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Count-up on first view (transitions.dev-style micro-interaction). Falls
 * back to the final value instantly under prefers-reduced-motion. Non-numeric
 * values render as-is.
 */
export function AnimatedNumber({ value }: { value: string }) {
  const target = Number(value.replace(/,/g, ''));
  const isNumeric = Number.isFinite(target);
  const [display, setDisplay] = useState(isNumeric ? '0' : value);
  const ref = useRef<HTMLSpanElement>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (!isNumeric) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setDisplay(target.toLocaleString());
      return;
    }
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting || ran.current) return;
      ran.current = true;
      const start = performance.now();
      const dur = 1100;
      const tick = (now: number) => {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
        setDisplay(Math.round(target * eased).toLocaleString());
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [isNumeric, target]);

  return <span ref={ref}>{display}</span>;
}
