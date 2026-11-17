"use client";
// Fades the page out the moment an internal link is clicked, so a click always answers at once; the next page fades
// in (app/template.tsx) when it is ready. Only same-site links in the same tab; modified clicks, new tabs, downloads
// and links to the same page are left alone. A navigation that never finishes is faded back in after a few seconds.
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export function NavFade() {
  const path = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    document.documentElement.classList.remove("leaving");
  }, [path, search]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
      if (url.pathname === location.pathname && url.search === location.search) return; // same page, or a #section on it
      document.documentElement.classList.add("leaving");
      clearTimeout(timer);
      timer = setTimeout(() => document.documentElement.classList.remove("leaving"), 4000);
    };
    const onPop = () => document.documentElement.classList.remove("leaving");
    document.addEventListener("click", onClick, true); // capture: before Link prevents the default
    window.addEventListener("popstate", onPop);
    return () => { document.removeEventListener("click", onClick, true); window.removeEventListener("popstate", onPop); clearTimeout(timer); };
  }, []);

  return null;
}
