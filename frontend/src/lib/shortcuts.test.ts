import { expect, test } from "bun:test";
import { matchesShortcut, validateShortcut } from "./shortcuts";
test("shortcut validation rejects malformed bindings", () => {
  expect(validateShortcut("Mod+Shift+P")).toBe(true);
  expect(validateShortcut("F10")).toBe(true);
  for (const value of ["", "Ctrl+", "Crtl+X", "Mod+Ctrl+X", "Shift+Shift+F9"])
    expect(validateShortcut(value)).toBe(false);
});
test("Mod follows the operating system instead of accepting either modifier", () => {
  const event = { key: "p", shiftKey: true, ctrlKey: true, metaKey: false, altKey: false };
  expect(matchesShortcut(event, "Mod+Shift+P", false)).toBe(true);
  expect(matchesShortcut(event, "Mod+Shift+P", true)).toBe(false);
  expect(matchesShortcut({ ...event, ctrlKey: false, metaKey: true }, "Mod+Shift+P", true)).toBe(
    true,
  );
});
