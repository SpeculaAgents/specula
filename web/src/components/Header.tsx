"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NAV, SITE } from "@/lib/site";
import { Close, GitHub, Menu, Moon, Sun, XLogo } from "./Icons";
import { Logo } from "./Logo";

/** Switch between the light and the dark theme, and remember the choice in this browser. */
function switchTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try {
    localStorage.setItem("specula-theme", next);
  } catch {
    /* storage is blocked: the choice lasts for this page */
  }
}

export function Header() {
  const path = usePathname();
  const [open, setOpen] = useState<string | null>(null);
  const shown = open === path; // the sheet closes by itself when the page changes
  const bar = useRef<HTMLElement | null>(null);
  const prog = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    // The header gains its line once the page has moved, and a thin bar tracks how far down you are.
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - innerHeight;
        bar.current?.classList.toggle("scrolled", scrollY > 8);
        if (prog.current) prog.current.style.transform = `scaleX(${max > 200 ? Math.min(1, scrollY / max) : 0})`;
      });
    };
    on();
    addEventListener("scroll", on, { passive: true });
    return () => (removeEventListener("scroll", on), cancelAnimationFrame(raf));
  }, [path]);
  return (
    <>
      <header className="top" ref={bar}>
        <span className="top-progress" ref={prog} aria-hidden />
        <div className="frame">
          <Link href="/" className="brand" aria-label="Specula, home">
            <Logo />
          </Link>
          <nav className="nav" aria-label="Sections">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={path === n.href || path.startsWith(`${n.href}/`) ? "page" : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="top-icons">
            <a className="icon-btn" href={SITE.github} target="_blank" rel="noreferrer" aria-label="Specula on GitHub">
              <GitHub />
            </a>
            <a className="icon-btn" href={SITE.x} target="_blank" rel="noreferrer" aria-label="Specula on X">
              <XLogo />
            </a>
            <button className="icon-btn theme-btn" onClick={switchTheme} aria-label="Switch between light and dark" title="Light or dark">
              <span className="moon"><Moon /></span>
              <span className="sun"><Sun /></span>
            </button>
            <button className="icon-btn menu-btn" onClick={() => setOpen(shown ? null : path)} aria-label={shown ? "Close menu" : "Open menu"} aria-expanded={shown}>
              {shown ? <Close /> : <Menu />}
            </button>
          </div>
        </div>
      </header>
      {shown && (
        <nav className="sheet" aria-label="Menu">
          {[...NAV, { href: "/status", label: "Status" }, { href: "/indexes", label: "Indexes" }, { href: "/verify", label: "Verify" }, { href: "/roadmap", label: "Roadmap" }].map((n, i) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(null)}>
              {n.label}
              <span>{String(i + 1).padStart(2, "0")}</span>
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
