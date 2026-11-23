// Work its callers share (an AI review, a PR's diff): one run per key while it's on its way. Forked through the runner: a
// caller leaving never stops it, and the desk stopping does, which ends its callers too. The fiber frees its slot and
// does `after` before they resume, unless the work was interrupted (the diff it waits on, ended by the desk stopping
// first): that does nothing more. One the stopped desk won't start ends them at once.
import { Cause, Deferred, Effect, Exit, type Fiber } from "effect";
import type { Runner } from "./runner.ts";

export class Shared<A, E> {
  private readonly runs = new Map<string, Deferred.Deferred<A, E>>();
  private readonly fibers = new WeakMap<object, Fiber.Fiber<unknown, unknown>>(); // by its Deferred
  private readonly host: { readonly runner: Runner };
  private readonly what: string;

  // `host`'s runner is read when work starts: the desk makes these before its runner.
  constructor(host: { readonly runner: Runner }, what: string) {
    this.host = host;
    this.what = what;
  }

  get size(): number {
    return this.runs.size;
  }

  get(id: string): Deferred.Deferred<A, E> | undefined {
    return this.runs.get(id);
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }

  delete(id: string): boolean {
    return this.runs.delete(id);
  }

  start(id: string, work: Effect.Effect<A, E>, after: (ok: boolean) => void = () => {}): Deferred.Deferred<A, E> {
    const running = this.runs.get(id);
    if (running) return running;
    const runs = this.runs;
    const d = Deferred.makeUnsafe<A, E>();
    runs.set(id, d);
    let result: Exit.Exit<A, E> | undefined; // the work's own: a bug in after() is the runner's, not its callers'
    const run = Effect.exit(work).pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          result = exit;
          runs.delete(id);
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
          after(Exit.isSuccess(exit));
        }),
      ),
      Effect.onExit((ended) =>
        Effect.sync(() => {
          if (runs.get(id) === d) runs.delete(id);
          Deferred.doneUnsafe(d, result ?? (Exit.isSuccess(ended) ? ended.value : Exit.failCause(ended.cause)));
        }),
      ),
    );
    const fiber = this.host.runner.fork(this.what, run, id);
    if (fiber) this.fibers.set(d, fiber);
    else {
      runs.delete(id);
      Deferred.doneUnsafe(d, Exit.interrupt());
    }
    return d;
  }

  // Stops the work on its way (an AI review past its time): its callers end with `err`, and it records nothing itself.
  stop(id: string, err: E): void {
    const d = this.runs.get(id);
    if (!d) return;
    Deferred.doneUnsafe(d, Exit.fail(err));
    this.fibers.get(d)?.interruptUnsafe();
  }
}
