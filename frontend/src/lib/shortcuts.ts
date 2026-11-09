export const defaultShortcuts: Record<string, string> = {
  continue: "F5",
  next: "F10",
  stepIn: "F11",
  stepOut: "Shift+F11",
  breakpoint: "F9",
  palette: "Mod+Shift+P",
};

export function validateShortcut(binding: string): boolean {
  const parts = binding.toLowerCase().trim().split("+");
  const key = parts.pop() || "";
  return (
    /^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|enter|escape|tab|backspace|delete|home|end|arrowup|arrowdown|arrowleft|arrowright|pageup|pagedown)$/.test(
      key,
    ) &&
    parts.every((part) => ["mod", "meta", "ctrl", "alt", "shift"].includes(part)) &&
    new Set(parts).size === parts.length &&
    !(parts.includes("mod") && (parts.includes("ctrl") || parts.includes("meta")))
  );
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
  binding: string,
  mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
) {
  const parts = binding.toLowerCase().trim().split("+");
  const ctrl = parts.includes("ctrl") || (parts.includes("mod") && !mac);
  const meta = parts.includes("meta") || (parts.includes("mod") && mac);
  return (
    event.key.toLowerCase() === parts.at(-1) &&
    event.shiftKey === parts.includes("shift") &&
    event.ctrlKey === ctrl &&
    event.metaKey === meta &&
    event.altKey === parts.includes("alt")
  );
}
