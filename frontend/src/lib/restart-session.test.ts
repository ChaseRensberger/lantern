import { expect, test } from "bun:test";
import { restartSession } from "./restart-session";

test("repeated restarts release the old slot and preserve other sessions", async () => {
  const sessions = new Set(Array.from({ length: 32 }, (_, i) => String(i)));
  let current = "0";
  for (let i = 32; i < 72; i++) {
    const old = current;
    await restartSession(old, {
      disconnect: async (id, terminate) => {
        expect(id).toBe(old);
        expect(terminate).toBe(true);
      },
      remove: async (id) => {
        sessions.delete(id);
      },
      start: async () => {
        expect(sessions.size).toBe(31);
        current = String(i);
        sessions.add(current);
      },
      refresh: async () => {},
    });
    expect(sessions.size).toBe(32);
    expect(sessions.has(old)).toBe(false);
    for (let j = 1; j < 32; j++) expect(sessions.has(String(j))).toBe(true);
  }
});

test("failed replacement still refreshes the removed session", async () => {
  let refreshed = false;
  await expect(
    restartSession("old", {
      disconnect: async () => {},
      remove: async () => {},
      start: async () => {
        throw Error("launch failed");
      },
      refresh: async () => {
        refreshed = true;
      },
    }),
  ).rejects.toThrow("launch failed");
  expect(refreshed).toBe(true);
});
