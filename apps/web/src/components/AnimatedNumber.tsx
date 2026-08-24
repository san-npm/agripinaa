'use client';

import { useEffect, useRef } from 'react';

/**
 * Count-up on first view (transitions.dev-style micro-interaction).
 *
 * React renders the final value and nothing else, so the server HTML a
 * crawler, a link preview, or a visitor without JavaScript receives carries
 * the number itself. It used to seed its state with "0", which is what a
 * statistic looked like in the served markup: a marketplace reporting that it
 * had no agents. The count-up is now a client-only DOM effect layered on top
 * of that markup, skipped entirely under prefers-reduced-motion, and
 * non-numeric values are left alone.
 */
export function AnimatedNumber({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const target = Number(value.replace(/,/g, ''));
    if (!Number.isFinite(target)) return;
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Rewind only once we are on the client and about to animate, so the
    // rendered markup never contains the placeholder.
    el.textContent = '0';
    let frame = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        observer.disconnect();
        const start = performance.now();
        const duration = 1100;
        const tick = (now: number) => {
          const progress = Math.min((now - start) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
          el.textContent =
            progress < 1 ? Math.round(target * eased).toLocaleString() : value;
          if (progress < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      el.textContent = value;
    };
  }, [value]);

  return <span ref={ref}>{value}</span>;
}
