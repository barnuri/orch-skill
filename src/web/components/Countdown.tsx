import { useEffect, useState } from "react";
import { until } from "../lib/format";

/** A live "4m 12s" until an epoch-seconds moment; ticks itself once a second. */
export function Countdown({ at }: { at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      tick((n) => n + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <>{until(at)}</>;
}
