"use client";
import { useEffect, useState } from "react";

/** The countdown to the team wallet's next buyback, with a bar that fills over the interval. */
export function BuybackClock({ nextAt, everyMin, live, serverNow }: { nextAt: string | null; everyMin: number; live: boolean; serverNow: number }) {
  // the server's clock for the first paint, so the page never shows an empty clock; the visitor's from then on
  const [now, setNow] = useState<number>(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const span = everyMin * 60_000;
  const target = nextAt ? Date.parse(nextAt) : null;
  let left = target !== null ? target - now : null;
  // a run that is due shows as running until the page hears about the next one
  const due = left !== null && left <= 0;
  if (left !== null && left < 0) left = 0;
  const mm = left === null ? "--" : String(Math.floor(left / 60_000)).padStart(2, "0");
  const ss = left === null ? "--" : String(Math.floor((left % 60_000) / 1000)).padStart(2, "0");
  const fill = left === null ? 0 : Math.min(1, Math.max(0, 1 - left / span));
  const label = !live
    ? "The first buyback starts once the token is live."
    : target === null
      ? "The first buyback runs within minutes."
      : due
        ? "Buying back and burning now."
        : `Every ${everyMin} minutes the team wallet buys back $SPECULA with the fees and burns it.`;

  return (
    <div className="bb-clock" aria-live="polite">
      <div className="bb-clock-head">
        <span className="bb-dot" data-on={live && !due ? "1" : due ? "2" : "0"} />
        <span>Next buyback and burn</span>
      </div>
      <div className="bb-time num" aria-label={left === null ? "not scheduled yet" : `${mm} minutes ${ss} seconds`}>
        {live ? <>{mm}<span className="bb-colon">:</span>{ss}</> : <>{String(everyMin).padStart(2, "0")}<span className="bb-colon">:</span>00</>}
      </div>
      <div className="bb-bar"><i style={{ transform: `scaleX(${live ? fill : 0})` }} /></div>
      <p className="bb-note">{label}</p>
    </div>
  );
}
