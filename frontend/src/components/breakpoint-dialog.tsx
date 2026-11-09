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
import type { Breakpoint, Capabilities } from "../lib/types";
import { errorText } from "../lib/api";
export function BreakpointDialog({
  point,
  path,
  caps,
  onClose,
  onSave,
}: {
  point: Breakpoint;
  path: string;
  caps: Capabilities;
  onClose: () => void;
  onSave: (point: Breakpoint) => Promise<void>;
}) {
  const [value, setValue] = useState(point),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            Breakpoint at line {point.line}
          </DialogTitle>
          <DialogDescription className="break-all text-xs text-muted-foreground">
            {path}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void onSave(value)
              .then(onClose)
              .catch((e) => setError(errorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          <label className="field">
            Condition
            <Input
              autoFocus
              disabled={!caps.supportsConditionalBreakpoints}
              value={value.condition}
              onChange={(e) => setValue({ ...value, condition: e.target.value })}
              placeholder={
                caps.supportsConditionalBreakpoints
                  ? "Optional boolean expression"
                  : "Not supported by this adapter"
              }
            />
          </label>
          <label className="field">
            Hit condition
            <Input
              disabled={!caps.supportsHitConditionalBreakpoints}
              value={value.hitCondition}
              onChange={(e) => setValue({ ...value, hitCondition: e.target.value })}
              placeholder={
                caps.supportsHitConditionalBreakpoints
                  ? "For example, 3 or >= 10"
                  : "Not supported by this adapter"
              }
            />
          </label>
          <label className="field">
            Log message
            <Input
              disabled={!caps.supportsLogPoints}
              value={value.logMessage}
              onChange={(e) => setValue({ ...value, logMessage: e.target.value })}
              placeholder={
                caps.supportsLogPoints
                  ? "Log instead of stopping; use {expression}"
                  : "Not supported by this adapter"
              }
            />
          </label>
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
              Save breakpoint
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
