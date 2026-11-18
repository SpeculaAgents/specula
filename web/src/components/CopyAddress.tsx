"use client";
import { useState } from "react";

/** The contract address in full, with a button that copies it. */
export function CopyAddress({ address }: { address: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="ca">
      <code className="ca-addr num">{address}</code>
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          void navigator.clipboard?.writeText(address).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          });
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
