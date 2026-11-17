// A small driver for the Chrome that is already on this machine, over its debugging port. No browser download.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 4290 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "specula-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  let version;
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!version) throw new Error("Chrome did not open its debugging port");
  return {
    async page() {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
      let id = 0;
      const waiting = new Map();
      const events = [];
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.id && waiting.has(m.id)) {
          const { res, rej } = waiting.get(m.id);
          waiting.delete(m.id);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        } else if (m.method) events.push(m);
      });
      const send = (method, params = {}) => new Promise((res, rej) => (waiting.set(++id, { res, rej }), ws.send(JSON.stringify({ id, method, params }))));
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Log.enable");
      // A tab opened over the debugging port starts in the background, where observers and animations do not run.
      await send("Page.bringToFront");
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      const evaluate = async (expression) => {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
        return r.result.value;
      };
      return {
        send,
        evaluate,
        events,
        async viewport(width, height, mobile = false) {
          await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
          if (mobile) await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
        },
        async goto(url, settle = 1200) {
          events.length = 0;
          await send("Page.navigate", { url });
          for (let i = 0; i < 150; i++) {
            if ((await evaluate("document.readyState").catch(() => "")) === "complete") break;
            await sleep(100);
          }
          await sleep(settle);
        },
        async shot() {
          const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          return Buffer.from(data, "base64");
        },
        errors: () => events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error") || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error")).map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.entry?.text ?? e.params.args?.map((a) => a.value ?? a.description).join(" ")),
        close: () => ws.close(),
      };
    },
    close() {
      proc.kill("SIGTERM");
      setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500);
    },
  };
}
export { sleep };
