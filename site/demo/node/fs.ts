import { absent } from "./absent.ts";

const fs = absent("node:fs");
export default fs;
export const { readFileSync, realpathSync, watchFile, writeFileSync, mkdirSync, rmSync, readFile, readdir, createReadStream } = fs;
export const existsSync = (): boolean => false;
