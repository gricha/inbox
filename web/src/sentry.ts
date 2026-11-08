// The UI's errors and traces go to Sentry once the desk says where (its overview): the mock and tests never say, so they
// send nothing.
import * as Sentry from "@sentry/react";
import type { Overview } from "../../src/types.ts";

let on = false;

export function startSentry(s: Overview["sentry"]): void {
  if (on || !s) return;
  on = true;
  Sentry.init({
    dsn: s.dsn,
    ...(s.release && { release: s.release }),
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.2,
    dataCollection: { userInfo: false }, // your IP stays off Sentry
    // The page's /api calls carry the trace on to the desk.
    tracePropagationTargets: [/^\/api\//],
  });
}

// A bug runUi caught: nothing handled it. Dropped until startSentry has run.
export function report(error: unknown): void {
  Sentry.captureException(error);
}

// React's own error hooks: a render error the Reload boundary catches is reported too. Setting them replaces React's
// console logging, so they log as well.
const log = Sentry.reactErrorHandler((error: unknown, info) => {
  console.error(error, info.componentStack);
});
export const reactErrors = { onUncaughtError: log, onCaughtError: log, onRecoverableError: log };
