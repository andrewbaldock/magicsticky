// Pure, unit-testable save-retry logic, extracted from Workspace so the highest-rot-risk code (a
// retry/backoff state machine on an autosaving app) is covered by fast tests rather than only
// verified-by-reading. Workspace wires these to timers + React state; the DECISIONS live here.

import { ApiError } from "./api.ts";

export const FIRST_RETRY_MS = 3_000;
export const MAX_RETRY_MS = 30_000;

// Exponential backoff capped at MAX. attempt 0 → 3s, 1 → 6s, 2 → 12s, 3 → 24s, 4+ → 30s.
export function nextDelay(attempt: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempt), MAX_RETRY_MS);
}

// What a failed save should do. Keeps the branching out of the async component so it's testable:
// - 401 → sign out (auth failure, NOT connectivity; never retry — retrying can't fix auth)
// - 409 → conflict: adopt the server's latest version, then re-save our text on top
// - anything else (network / 5xx / offline) → retry with backoff (the edit stays queued)
export type SaveOutcome = "signout" | "conflict" | "retry";

export function classifySaveError(error: unknown): SaveOutcome {
  if (error instanceof ApiError && error.status === 401) return "signout";
  if (error instanceof ApiError && error.status === 409) return "conflict";
  return "retry";
}
