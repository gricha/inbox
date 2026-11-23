// node:module, node:net, node:sqlite, node:http, node:async_hooks, node:util, node:stream: nothing the demo reaches.
import { absent, fail } from "./absent.ts";

const misc = absent("node builtin");
export default misc;
export const { createServer, parseArgs, promisify, init, Readable, DatabaseSync, Server } = misc;
export class AsyncLocalStorage<T> {
  run<R>(_store: T, fn: () => R): R {
    return fn();
  }
  static snapshot(): <R>(fn: () => R) => R {
    return (fn) => fn();
  }
  getStore(): T | undefined {
    return undefined;
  }
}

// Modules make their require at load (render.ts takes ELK then): a required module is a function that fails when called,
// as resolving a file does.
export const createRequire = () => Object.assign(() => () => fail("a required module"), { resolve: () => fail("require.resolve") });
