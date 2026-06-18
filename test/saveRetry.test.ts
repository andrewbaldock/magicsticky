// Unit tests for the save-retry decision logic (extracted from Workspace per Cowork's gate — the
// highest-rot-risk code: a retry state machine on an autosaving app). Pure functions, no DOM/timers.

import { test, expect } from "bun:test";
import { nextDelay, classifySaveError, FIRST_RETRY_MS, MAX_RETRY_MS } from "../web/saveRetry.ts";
import { ApiError } from "../web/api.ts";

test("nextDelay backs off exponentially and caps", () => {
  expect(nextDelay(0)).toBe(3_000);
  expect(nextDelay(1)).toBe(6_000);
  expect(nextDelay(2)).toBe(12_000);
  expect(nextDelay(3)).toBe(24_000);
  expect(nextDelay(4)).toBe(MAX_RETRY_MS); // 48k → capped at 30k
  expect(nextDelay(10)).toBe(MAX_RETRY_MS); // stays capped
  expect(nextDelay(0)).toBe(FIRST_RETRY_MS);
});

test("nextDelay never returns below the first delay (guards negative attempts)", () => {
  expect(nextDelay(-5)).toBe(FIRST_RETRY_MS);
});

test("classifySaveError: 401 → signout (never retry — retrying can't fix auth)", () => {
  expect(classifySaveError(new ApiError("unauthorized", 401))).toBe("signout");
});

test("classifySaveError: 409 → conflict (adopt latest, re-save on top)", () => {
  expect(classifySaveError(new ApiError("conflict", 409))).toBe("conflict");
});

test("classifySaveError: network / 5xx / unknown → retry (keep the edit queued)", () => {
  expect(classifySaveError(new ApiError("server", 500))).toBe("retry");
  expect(classifySaveError(new ApiError("offline", 0))).toBe("retry");
  expect(classifySaveError(new TypeError("Failed to fetch"))).toBe("retry"); // bare network error
  expect(classifySaveError(undefined)).toBe("retry");
});
