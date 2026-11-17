"use client";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/** Fades its content up when it scrolls into view. One observer per element; it stops watching once shown. */
export function Reveal({ children, delay = 0, className = "", as: Tag = "div", style }: { children: ReactNode; delay?: number; className?: string; as?: "div" | "li" | "section"; style?: CSSProperties }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      el.classList.add("in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            el.classList.add("in");
            io.disconnect();
          }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref as never} className={`reveal ${className}`} style={{ ...style, ["--d" as string]: delay }}>
      {children}
    </Tag>
  );
}
