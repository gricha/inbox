// This device's storage, which can be off (a private window, blocked site data): a read then finds nothing, and what's
// written holds until the window closes.
import { Effect } from "effect";

const area = (session: boolean) => (session ? sessionStorage : localStorage);

export const getStored = (key: string, session = false): string | null =>
  Effect.runSync(Effect.try({ try: () => area(session).getItem(key), catch: (e) => e }).pipe(Effect.orElseSucceed(() => null)));

// null removes it.
export function setStored(key: string, value: string | null, session = false): void {
  Effect.runSync(
    Effect.try({
      try: () => {
        if (value === null) area(session).removeItem(key);
        else area(session).setItem(key, value);
      },
      catch: (e) => e,
    }).pipe(Effect.ignore),
  );
}
