// The mock's desk modules import Node builtins for work the in-browser demo never does; a call says which one it reached.
export const fail = (what: string): never => {
  throw new Error(`${what} isn't available in the browser demo`);
};

export const absent = (mod: string): Record<string, (...args: unknown[]) => never> =>
  new Proxy(
    {},
    {
      get: (_, key) => () => fail(`${mod}.${String(key)}`),
    },
  );
