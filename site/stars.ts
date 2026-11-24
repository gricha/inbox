// A star count as the navbar shows it: 56, 1.2k.
export const compact = (n: number): string =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n).toLowerCase();
