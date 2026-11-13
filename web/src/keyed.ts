import { useEffect, useEffectEvent, useLayoutEffect } from "react";

// What a keyed effect does: it sees the latest props and state, and may return its cleanup. signal aborts when the key
// changes or the component goes, for a read to pass to runUi.
type Run = (signal: AbortSignal) => void | (() => void);

// Runs `run` now and again each time `key` changes, the one before cleaned up first. The key is the trigger: loads (the
// desk answered with new state), an id, a section; null is off. `run` isn't one, so its props never refire it.
export function useKeyed(key: unknown, run: Run): void {
  const fire = useEffectEvent(run);
  useEffect(() => {
    const stop = new AbortController();
    const done = key === null ? undefined : fire(stop.signal);
    return () => {
      stop.abort();
      done?.();
    };
  }, [key]);
}

// The same before paint: for an effect that measures or scrolls what the key's change just rendered.
export function useKeyedLayout(key: unknown, run: Run): void {
  const fire = useEffectEvent(run);
  useLayoutEffect(() => {
    const stop = new AbortController();
    const done = key === null ? undefined : fire(stop.signal);
    return () => {
      stop.abort();
      done?.();
    };
  }, [key]);
}
