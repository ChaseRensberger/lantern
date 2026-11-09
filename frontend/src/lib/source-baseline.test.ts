import { expect, test } from "bun:test";
import { SourceBaseline } from "./source-baseline";

test("reloading and revisiting source cannot clear the session mismatch", () => {
  const baseline = new SourceBaseline();
  expect(baseline.observe("main.go", "original")).toBe(false);
  expect(baseline.observe("main.go", "edited")).toBe(true);
  expect(baseline.observe("main.go", "edited")).toBe(true);
  expect(baseline.observe("other.go", "other")).toBe(false);
  expect(baseline.hasChanged("main.go")).toBe(true);
  expect(baseline.observe("main.go", "original")).toBe(true);
  expect(new SourceBaseline().observe("main.go", "edited")).toBe(false);
});
