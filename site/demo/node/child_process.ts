import { absent } from "./absent.ts";

const cp = absent("node:child_process");
export default cp;
export const { spawnSync, execFile, spawn } = cp;
