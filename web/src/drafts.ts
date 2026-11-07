// Your inline comments not yet sent, and the keyboard while you write one. Kept by PR for this window, so leaving a
// review (a link, the back link, Esc) and coming back finds your words where you left them.
import type { InlineAt } from "../../src/types.ts";

export interface Kept {
  at: InlineAt;
  thread: string | null; // a reply to this review thread
  head: string; // the commit whose diff the line was picked on
  text: string;
}

const kept = new Map<string, Kept>();

export const keptDraft = (pr: string): Kept | null => kept.get(pr) ?? null;

export function keepDraft(pr: string, d: Kept | null): void {
  if (d?.text.trim()) kept.set(pr, d);
  else kept.delete(pr);
}

const sending = new Set<string>();
const watchers = new Set<(pr: string) => void>();

// One comment on its way per PR: a review opened again meanwhile waits for it rather than starting another.
export function sendingOn(pr: string, on: boolean): void {
  if (on) sending.add(pr);
  else sending.delete(pr);
}

export const isSending = (pr: string): boolean => sending.has(pr);

// A send GitHub refused: its words go back to the PR, and a review of it that's open shows them.
export function returnDraft(pr: string, d: Kept): void {
  keepDraft(pr, d);
  for (const w of watchers) w(pr);
}

export function watchKept(fn: (pr: string) => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

const CAP_MS = 5000; // past this with no box back, keys are the page's again

let held = false;
let gone = 0;

// You're typing in a box: until a real blur (Esc, a click elsewhere, a fold), keys are its.
export function holdKeys(on: boolean): void {
  held = on;
  if (!on) gone = 0;
}

// The box was taken out of the page while you typed in it (a refresh regrouped its file): it's being drawn again.
export function boxGone(): void {
  if (held) gone = Date.now();
}

// The box is back with the cursor, or gave up on taking it.
export function boxBack(): void {
  gone = 0;
}

// Keys meanwhile land on the page: they're swallowed, so Esc can't go back.
export function keysHeld(): boolean {
  const page = document.activeElement === null || document.activeElement === document.body;
  return held && gone > 0 && page && Date.now() - gone < CAP_MS;
}

export const holding = (): boolean => held;
