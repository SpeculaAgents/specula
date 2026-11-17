import { readFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";

const MARK = `data:image/png;base64,${readFileSync(path.join(process.cwd(), "public", "logo-large.png")).toString("base64")}`;

export const alt = "Specula: the data terminal for AI agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Og() {
  const cell = (s: string, i: number) => (
    <div key={i} style={{ display: "flex", width: 150, height: 86, borderRight: "1px solid #dcdcdc", borderBottom: "1px solid #dcdcdc", alignItems: "flex-start", padding: 14, fontSize: 18, color: "#6b6b6b", letterSpacing: 2 }}>{s}</div>
  );
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#ffffff", color: "#0c0c0c", fontFamily: "monospace" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, width: 720 }}>
          <div style={{ display: "flex", alignItems: "center", fontSize: 30, letterSpacing: 6, fontWeight: 700 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={MARK} alt="" width={44} height={44} style={{ marginRight: 16 }} />
            SPECULA
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 76, lineHeight: 1, fontWeight: 700, letterSpacing: -2 }}>Data your agent buys by the answer.</div>
            <div style={{ display: "flex", fontSize: 26, color: "#3d3d3d", marginTop: 28 }}>The data terminal for AI agents.</div>
          </div>
          <div style={{ display: "flex", fontSize: 20, color: "#6b6b6b", letterSpacing: 2 }}>SPECULAAGENTS.FUN</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", width: 480, borderLeft: "1px solid #0c0c0c", alignContent: "flex-start" }}>
          {["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "ETH", "BTC", "SPY", "QQQ", "8-K", "FORM 4", "13F", "CPI", "YIELD", "JOBS", "TRADES", "HOLDERS", "LAUNCH", "FEES", "SIGNAL"].map(cell)}
        </div>
      </div>
    ),
    size,
  );
}
