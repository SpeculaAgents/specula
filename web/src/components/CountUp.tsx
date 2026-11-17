"use client";
import { useEffect, useRef, useState } from "react";

/** A number that counts up to its value when it first scrolls into view, and glides to each new value after. */
export function CountUp({ value, digits = 0, suffix = "" }: { value: number | null | undefined; digits?: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const shown = useRef(0);
  const [seen, setSeen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) + suffix;

  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return void setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setSeen(true), io.disconnect()), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!seen || value === null || value === undefined) return;
    const from = shown.current;
    const to = value;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === to) {
      shown.current = to;
      return void setText(fmt(to));
    }
    const t0 = performance.now();
    const dur = Math.min(1600, 500 + Math.abs(to - from) * 4);
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const cur = from + (to - from) * (1 - Math.pow(1 - p, 4));
      shown.current = cur;
      setText(fmt(cur));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, value]);

  // Before it is seen (and without JavaScript) the real value is in the page, so nothing ever reads as zero.
  return <span ref={ref}>{value === null || value === undefined ? "n/a" : (text ?? fmt(value))}</span>;
}
