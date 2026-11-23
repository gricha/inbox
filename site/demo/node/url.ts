export const fileURLToPath = (u: string | URL): string => new URL(String(u)).pathname;
export const pathToFileURL = (p: string): URL => new URL(`file://${p}`);
export default { fileURLToPath, pathToFileURL };
