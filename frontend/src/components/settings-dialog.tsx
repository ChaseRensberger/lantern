import { useState } from "react";
import { Button } from "./core/button";
import { Input } from "./core/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./core/dialog";
import { defaultShortcuts, validateShortcut } from "../lib/shortcuts";
import { parseEditorCommand } from "../lib/inspection";
import type { Preferences, Theme } from "../lib/types";
import { errorText } from "../lib/api";
export function SettingsDialog({
  prefs,
  onSave,
  onClose,
}: {
  prefs: Preferences;
  onSave: (prefs: Partial<Preferences>) => Promise<void>;
  onClose: () => void;
}) {
  const [theme, setTheme] = useState(prefs.theme),
    [editor, setEditor] = useState(JSON.stringify(prefs.editorCommand)),
    [shortcuts, setShortcuts] = useState({ ...defaultShortcuts, ...prefs.shortcuts }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Settings</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Appearance, editor, and keyboard preferences.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            setBusy(true);
            void (async () => {
              const command = parseEditorCommand(editor);
              if (Object.values(shortcuts).some((value) => !validateShortcut(value)))
                throw Error("Use a valid shortcut such as F5, Shift+F11, or Mod+Shift+P.");
              if (
                new Set(Object.values(shortcuts).map((value) => value.trim().toLowerCase()))
                  .size !== Object.keys(shortcuts).length
              )
                throw Error("Shortcuts must be unique.");
              await onSave({ theme, editorCommand: command, shortcuts });
              onClose();
            })()
              .catch((e) => setError(errorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          <label className="field">
            Appearance
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
              <option value="system">Follow system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="field">
            Editor command as a JSON array
            <Input value={editor} onChange={(e) => setEditor(e.target.value)} spellCheck={false} />
            <span className="text-xs text-muted-foreground">
              Use {"{file}"} and {"{line}"} placeholders. [] uses the default text-file application.
              For Neovim, include your terminal's launch arguments before nvim. Commands run without
              a shell.
            </span>
          </label>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-3 text-sm font-medium">Keyboard shortcuts</legend>
            {Object.entries(shortcuts).map(([command, binding]) => (
              <label key={command} className="grid grid-cols-2 items-center gap-3">
                <span className="text-xs">
                  {{
                    continue: "Continue",
                    next: "Step over",
                    stepIn: "Step into",
                    stepOut: "Step out",
                    breakpoint: "Toggle breakpoint",
                    palette: "Command palette",
                  }[command] || command}
                </span>
                <Input
                  aria-label={`${command} shortcut`}
                  value={binding}
                  onChange={(e) =>
                    setShortcuts((current) => ({ ...current, [command]: e.target.value }))
                  }
                />
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              Use F5, Shift+F11, or Mod+Shift+P. Mod means Command on macOS and Control on Linux.
            </p>
          </fieldset>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save settings
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
