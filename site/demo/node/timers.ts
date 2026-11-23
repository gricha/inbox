export const setTimeout = (ms: number): Promise<void> =>
  new Promise((ok) => {
    globalThis.setTimeout(ok, ms);
  });
