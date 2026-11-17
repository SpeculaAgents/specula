// Real-viewport screenshots of every page, desktop 1440x900 and phone 390x844, at the top, the middle and the bottom.
// Never full-page captures (a fixed header would be drawn mid-page). Fails if any page scrolls sideways.
//   SHOTS_SITE=http://127.0.0.1:4200 node test/shots.mjs [/path ...]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";

const site = process.env.SHOTS_SITE || "http://localhost:4200";
const out = process.env.SHOTS_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shots");
const ALL = ["/", "/feeds", "/feeds/chain.price", "/docs", "/terminal", "/signals", "/ask", "/verify", "/indexes", "/status", "/market", "/lab", "/demand", "/roadmap", "/changelog", "/token", "/own-risk"];
const pages = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const only = process.env.SHOTS_VIEW;
mkdirSync(out, { recursive: true });

const browser = await launch();
let bad = 0;
try {
  for (const [name, w, h, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]]) {
    if (only && only !== name) continue;
    const page = await browser.page();
    await page.viewport(w, h, mobile);
    for (const path of pages) {
      await page.goto(site + path, 1800);
      const slug = path === "/" ? "home" : path.slice(1).replace(/[/.]/g, "-");
      const { height, overflow } = await page.evaluate(`(() => ({ height: document.documentElement.scrollHeight, overflow: Math.max(document.documentElement.scrollWidth, window.innerWidth) - ${w} }))()`);
      if (overflow > 1) {
        bad++;
        const who = await page.evaluate(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > ${w} + 1 && getComputedStyle(e).position !== 'fixed').slice(0,5).map(e => e.tagName + '.' + e.className).join(' | ')`);
        console.log(`SIDEWAYS SCROLL ${name} ${path}: ${overflow}px  ${who}`);
      }
      const stops = height <= h + 40 ? [0] : [...new Set([0, Math.round((height - h) / 2), height - h])];
      for (let i = 0; i < stops.length; i++) {
        await page.evaluate(`window.scrollTo(0, ${stops[i]})`);
        await sleep(900);
        writeFileSync(join(out, `${slug}-${name}-${i + 1}.png`), await page.shot());
      }
      const errs = page.errors();
      if (errs.length) console.log(`console errors ${name} ${path}:`, errs.slice(0, 3));
      console.log(`${name} ${path}  ${height}px  ${stops.length} shots`);
    }
    page.close();
  }
} finally {
  browser.close();
}
if (bad) process.exit(1);
