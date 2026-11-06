"use client";

import { useEffect } from "react";
import { watchVitals } from "./beacon";

// Design notes: docs/architecture.md.

// Measures the page's web vitals and sends them to /rum. web-vitals is loaded only after the page's load event, in a
// chunk of its own, so it takes nothing from the first paint; its observers read the entries the browser buffered
// before. Rendered by the root layout: global-error replaces that layout, so its error page sends nothing. Under
// error.tsx and nested boundaries the layout stays mounted and still sends: real data of the page before the error.
export function VitalsReporter() {
  useEffect(() => {
    // The page the visit loaded, before any client-side navigation (beacon.ts).
    const path = location.pathname;
    let cancelled = false;
    let stop: (() => void) | undefined;
    const start = () => {
      import("web-vitals").then(
        (webVitals) => {
          if (!cancelled) {
            stop = watchVitals(webVitals, path);
          }
        },
        () => {},
      );
    };
    if (document.readyState === "complete") {
      start();
    } else {
      addEventListener("load", start, { once: true });
    }
    return () => {
      cancelled = true;
      removeEventListener("load", start);
      stop?.();
    };
  }, []);
  return null;
}
