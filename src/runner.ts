// Work the desk starts and nobody waits on (a sync after a reload, the loops' passes, an AI review, the coordinator's run):
// each in a trace of its own, what fails logged and reported, and all of it interrupted when the desk stops. It's the
// only way the desk forks: Effect.runFork alone loses whatever fails, forkChild ends with its caller, and a voided
// Effect.runPromise is an unhandled rejection, which ends the desk.
import { Cause, Effect, Exit, type Fiber } from "effect";

export class Runner {
  private stopped = false;
  private readonly fibers = new Set<Fiber.Fiber<unknown, unknown>>();
  private readonly log: (m: string) => void;
  private readonly report: (err: unknown, what: string, item?: string) => void;
  private readonly detached: (fn: () => void) => void;

  constructor(log: (m: string) => void, report: (err: unknown, what: string, item?: string) => void, detached: (fn: () => void) => void) {
    this.log = log;
    this.report = report;
    this.detached = detached;
  }

  // Each site handles its expected failures itself (stores its *_error, logs in its own words): what reaches here is a
  // failure nobody handled, or a bug. Interruption, and anything ending after stop(), is quiet.
  fork<A, E>(what: string, effect: Effect.Effect<A, E>, item?: string): Fiber.Fiber<A, E> | null {
    if (this.stopped) return null;
    let fiber: Fiber.Fiber<A, E> | undefined;
    this.detached(() => {
      fiber = Effect.runFork(effect);
    });
    const f = fiber!;
    this.fibers.add(f);
    f.addObserver((exit) => {
      this.fibers.delete(f);
      if (Exit.isSuccess(exit) || this.stopped || Cause.hasInterruptsOnly(exit.cause)) return;
      this.log(`${what} failed: ${Cause.pretty(exit.cause)}`);
      this.report(Cause.squash(exit.cause), what, item);
    });
    return f;
  }

  // Synchronous, so Desk.stop() stays so: an interrupted fiber's finalizers (killing a child, clearing a timer, releasing a
  // lock) run before this returns, unless one waits on something.
  stop(): void {
    this.stopped = true;
    for (const f of this.fibers) f.interruptUnsafe();
  }
}
