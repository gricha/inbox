// POSIX paths, as much of node:path as the mock's modules use for names it only shows.
const norm = (p: string): string => {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
};
export const sep = "/";
export const join = (...p: string[]): string => norm(p.filter(Boolean).join("/"));
export const resolve = (...p: string[]): string => {
  let r = "";
  for (const s of p) r = s.startsWith("/") ? s : `${r}/${s}`;
  return norm(r.startsWith("/") ? r : `/${r}`);
};
export const dirname = (p: string): string => {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i < 0 ? "." : i === 0 ? "/" : p.slice(0, i);
};
export const basename = (p: string, ext?: string): string => {
  const b = p.replace(/\/+$/, "").split("/").pop() ?? "";
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const extname = (p: string): string => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
};
export const relative = (from: string, to: string): string => {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
};
export const isAbsolute = (p: string): boolean => p.startsWith("/");
export const normalize = norm;
const path = { sep, join, resolve, dirname, basename, extname, relative, isAbsolute, normalize };
export const posix = path;
export default path;
