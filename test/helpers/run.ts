// Running the desk's Effects in tests. run and runSync give the value, or throw the typed failure itself as the code
// would have; a defect (a bug, or a tagged error thrown where it should have been yielded, which the server answers 500)
// fails the test instead of passing as a refusal. failure and failureSync give the typed failure, for asserting on its
// _tag and message.
import assert from "node:assert/strict";
import { Cause, Effect, Exit, Option } from "effect";

function settle<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const e = Cause.findErrorOption(exit.cause);
  if (Option.isSome(e) && e.value instanceof Error) throw e.value;
  return assert.fail(`expected a value or a typed failure, got ${Cause.pretty(exit.cause)}`);
}

function failed<A, E>(exit: Exit.Exit<A, E>): E {
  if (Exit.isSuccess(exit)) return assert.fail(`expected a failure, got ${JSON.stringify(exit.value)}`);
  const e = Cause.findErrorOption(exit.cause);
  if (Option.isNone(e)) return assert.fail(`expected a typed failure, got ${Cause.pretty(exit.cause)}`);
  return e.value;
}

/** @public until C1 */
export const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => settle(await Effect.runPromiseExit(effect));

/** @public until C1 */
export const runSync = <A, E>(effect: Effect.Effect<A, E>): A => settle(Effect.runSyncExit(effect));

/** @public until C1 */
export const failure = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => failed(await Effect.runPromiseExit(effect));

/** @public until C1 */
export const failureSync = <A, E>(effect: Effect.Effect<A, E>): E => failed(Effect.runSyncExit(effect));
