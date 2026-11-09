import { useId, useState } from "react";
import { FolderOpen } from "@phosphor-icons/react";
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
import { api, errorText } from "../lib/api";
import { emptyConfig, type LaunchConfig } from "../lib/types";

export function LaunchDialog({
  open,
  initial,
  onClose,
  onLaunch,
  onSave,
}: {
  open: boolean;
  initial?: LaunchConfig;
  onClose: () => void;
  onLaunch: (config: LaunchConfig) => Promise<void>;
  onSave: (config: LaunchConfig) => Promise<void>;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent>
        <LaunchForm
          key={initial?.id || "new"}
          initial={initial}
          onClose={onClose}
          onLaunch={onLaunch}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  );
}

function LaunchForm({
  initial,
  onClose,
  onLaunch,
  onSave,
}: {
  initial?: LaunchConfig;
  onClose: () => void;
  onLaunch: (config: LaunchConfig) => Promise<void>;
  onSave: (config: LaunchConfig) => Promise<void>;
}) {
  const formID = useId();
  const [config, setConfig] = useState<LaunchConfig>(() =>
    initial ? structuredClone(initial) : emptyConfig(),
  );
  const [args, setArgs] = useState(JSON.stringify(initial?.args || []));
  const [env, setEnv] = useState(
    Object.entries(initial?.env || {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = <K extends keyof LaunchConfig>(key: K, value: LaunchConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));
  async function submit(launch: boolean) {
    setError("");
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(args);
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string"))
        throw Error(
          'Arguments must be a JSON array of strings, for example ["-test.run", "TestTotal"].',
        );
      const environment: Record<string, string> = {};
      for (const line of env.split("\n").filter((line) => line.trim())) {
        const at = line.indexOf("=");
        if (at < 1) throw Error("Each environment override must use NAME=value on its own line.");
        environment[line.slice(0, at).trim()] = line.slice(at + 1);
      }
      if (!config.name.trim()) throw Error("Enter a session name.");
      const ready = { ...config, args: parsed as string[], env: environment };
      if (launch) await onLaunch(ready);
      else await onSave(ready);
      onClose();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-base font-semibold">
          {initial ? "Session configuration" : "New debug session"}
        </DialogTitle>
        <DialogDescription className="text-xs text-muted-foreground">
          Go through Delve. Configuration stays on this machine.
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(true);
        }}
      >
        <label className="field">
          Name
          <Input
            autoFocus
            required
            value={config.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="Orders service"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="field">
            Connection
            <select
              value={config.kind}
              onChange={(e) => update("kind", e.target.value as LaunchConfig["kind"])}
            >
              <option value="launch">Launch with Delve</option>
              <option value="endpoint">Existing Delve endpoint</option>
            </select>
          </label>
          {config.kind === "launch" && (
            <label className="field">
              Target
              <select
                value={config.mode}
                onChange={(e) => update("mode", e.target.value as LaunchConfig["mode"])}
              >
                <option value="debug">Go package</option>
                <option value="test">Go test package</option>
                <option value="exec">Built executable</option>
              </select>
            </label>
          )}
        </div>
        {config.kind === "endpoint" ? (
          <>
            <label className="field">
              Loopback address
              <Input
                required
                value={config.endpoint}
                onChange={(e) => update("endpoint", e.target.value)}
                placeholder="127.0.0.1:38697"
              />
            </label>
            <p className="text-xs text-warning">
              Connect to a headless Delve server already debugging a target. Connecting pauses the
              target until you choose Continue. Use --accept-multiclient when you need the server to
              survive disconnects.
            </p>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor={`${formID}-program`}>
                {config.mode === "exec" ? "Executable path" : "Package directory"}
              </label>
              <div className="flex gap-2">
                <Input
                  id={`${formID}-program`}
                  required
                  value={config.program}
                  onChange={(e) => update("program", e.target.value)}
                  placeholder="/absolute/path/to/project"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Browse for target"
                  onClick={() =>
                    void api
                      .choose(config.mode !== "exec")
                      .then((path) => {
                        if (path) update("program", path);
                      })
                      .catch((e) => setError(errorText(e)))
                  }
                >
                  <FolderOpen aria-hidden="true" />
                </Button>
              </div>
            </div>
            <label className="field">
              Arguments as a JSON array
              <Input value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
            </label>
          </>
        )}
        <details className="advanced">
          <summary>Advanced settings</summary>
          <div className="flex flex-col gap-3 pt-3">
            <label className="field">
              Working directory{config.kind === "endpoint" ? " / local source root" : ""}
              <Input
                value={config.cwd}
                onChange={(e) => update("cwd", e.target.value)}
                placeholder={
                  config.kind === "launch"
                    ? "Defaults to the package directory"
                    : "Optional absolute path"
                }
              />
            </label>
            {config.kind === "launch" && (
              <>
                <label className="field">
                  Environment overrides
                  <textarea
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                    rows={3}
                    placeholder="NAME=value"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Saved in your private local settings, never in the project.
                  </span>
                </label>
                <label className="field">
                  Build flags
                  <Input
                    value={config.buildFlags}
                    onChange={(e) => update("buildFlags", e.target.value)}
                    placeholder="Optional, for example -tags=integration"
                  />
                </label>
                <label className="field">
                  Delve executable
                  <Input
                    value={config.delvePath}
                    onChange={(e) => update("delvePath", e.target.value)}
                    placeholder="Find dlv on PATH"
                  />
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={config.stopOnEntry}
                    onChange={(e) => update("stopOnEntry", e.target.checked)}
                  />
                  Pause before runtime initialization. Stacks and variables may not be available
                  yet.
                </label>
              </>
            )}
          </div>
        </details>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void submit(false)}
            disabled={busy}
          >
            Save configuration
          </Button>
          <Button type="submit" disabled={busy} aria-busy={busy}>
            {busy ? "Starting…" : config.kind === "endpoint" ? "Connect" : "Launch"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
