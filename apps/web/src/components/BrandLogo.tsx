'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

const EXPRESSIONS = ['curieux', 'excite', 'hilare', 'timide', 'neutre'];

/** User-supplied exports stay intact and isolated as images, not injected SVG. */
export function BrandLogo({ className = '' }: { className?: string }) {
  const still = '/brand/bloub/bloub-hexagone-neutre-orange.svg';
  const [playing, setPlaying] = useState(true);
  const [expression, setExpression] = useState(0);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: no-preference)');
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (playing && motion.matches && document.visibilityState === 'visible') {
        timer = setInterval(() => setExpression((index) => (index + 1) % EXPRESSIONS.length), 6_000);
      }
    };
    sync();
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearInterval(timer);
      motion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [playing]);
  const mark = <picture className={`bloub-logo ${className}`}>
    {playing && <source media="(prefers-reduced-motion: no-preference)" srcSet={`/brand/bloub/bloub-hexagone-${EXPRESSIONS[expression]}-orange-anime.svg`} />}
    <Image src={still} alt="" aria-hidden width={80} height={80} loading="eager" unoptimized />
  </picture>;
  return <button type="button" className="mascot-toggle" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause mascot animation' : 'Play mascot animation'} aria-pressed={!playing} title={playing ? 'Pause mascot animation' : 'Play mascot animation'}>
    {mark}
  </button>;
}
