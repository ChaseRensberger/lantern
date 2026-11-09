import { describe, expect, test } from "bun:test";
import {
  ObservedValues,
  parseEditorCommand,
  hoverExpression,
  dataForPause,
  cacheSource,
} from "./inspection";

test("source cache retains at most twelve files", () => {
  let files: Record<string, { path: string; content: string; hash: string }> = {};
  for (let i = 0; i < 30; i++)
    files = cacheSource(files, { path: `${i}.go`, content: "package main", hash: String(i) });
  expect(Object.keys(files)).toHaveLength(12);
  expect(files["0.go"]).toBeUndefined();
  expect(files["29.go"].hash).toBe("29");
});
const variable = (value: string) => ({ name: "total", type: "int", value, variablesReference: 0 });
test("old frame and scope handles cannot be relabeled with a new pause", () => {
  const old = { key: "session/1/thread/3", data: [{ variablesReference: 1000 }] };
  expect(dataForPause(old, "session/1/thread/3")).toEqual(old.data);
  expect(dataForPause(old, "session/2/thread/3")).toBeUndefined();
  expect(dataForPause(old, "another-session/1/thread/3")).toBeUndefined();
});
describe("observed values", () => {
  test("compares only values observed in the same frame context", () => {
    const values = new ObservedValues();
    values.begin("session/thread/function", 1);
    expect(values.observe("locals/total", variable("0"))).toBe(false);
    values.begin("session/thread/function", 2);
    expect(values.observe("locals/total", variable("12"))).toBe(true);
    expect(values.observe("locals/unseen", variable("12"))).toBe(false);
    values.begin("another-session/thread/function", 2);
    expect(values.observe("locals/total", variable("99"))).toBe(false);
  });
});
test("hover expressions are bounded identifier paths", () => {
  expect(hoverExpression("subtotal += item.Price * item.Quantity", 18)?.text).toBe("item.Price");
  expect(hoverExpression("total(order)", 3)?.text).toBe("total");
  expect(hoverExpression("x + y", 2)).toBeNull();
});
test("editor arguments require a filename placeholder without invoking a shell", () => {
  expect(parseEditorCommand('["nvim", "+{line}", "--", "{file}"]')).toHaveLength(4);
  expect(() => parseEditorCommand('["nvim"]')).toThrow();
  expect(() => parseEditorCommand('"nvim {file}"')).toThrow();
  expect(parseEditorCommand("[]")).toEqual([]);
});
