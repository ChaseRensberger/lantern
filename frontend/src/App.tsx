import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import {
  BugBeetle,
  Command,
  Gear,
  Plus,
  Play,
  ArrowRight,
  X,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button } from "./components/core/button";
import { Input } from "./components/core/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./components/core/dialog";
import { LaunchDialog } from "./components/launch-dialog";
import { SettingsDialog } from "./components/settings-dialog";
import { defaultShortcuts, matchesShortcut } from "./lib/shortcuts";
import { api, errorText } from "./lib/api";
import { restartSession } from "./lib/restart-session";
import {
  active,
  type Breakpoint,
  type LaunchConfig,
  type Preferences,
  type Session,
  type Settings,
} from "./lib/types";

const defaultPrefs: Preferences = {
  theme: "system",
  watches: [],
  editorCommand: [],
  shortcuts: defaultShortcuts,
};
const Workspace = lazy(() =>
  import("./components/workspace").then((module) => ({ default: module.Workspace })),
);
interface Confirmation {
  title: string;
  description: string;
  action: () => Promise<void>;
  label: string;
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]),
    [selected, setSelected] = useState("");
  const [settings, setSettings] = useState<Settings>({ version: 1, launches: [], preferences: {} });
  const [ready, setReady] = useState(false),
    [connectionError, setConnectionError] = useState(""),
    [error, setError] = useState("");
  const [info, setInfo] = useState<{ os: string; delve: string; version: string } | null>(null);
  const [launch, setLaunch] = useState<{ initial?: LaunchConfig } | null>(null),
    [showSettings, setShowSettings] = useState(false);
  const [palette, setPalette] = useState(false),
    [query, setQuery] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [confirmBusy, setConfirmBusy] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const saveQueue = useRef(Promise.resolve());
  const refreshRunning = useRef(false);
  const mounted = useRef(true);
  const prefs: Preferences = {
    ...defaultPrefs,
    ...settings.preferences,
    shortcuts: { ...defaultShortcuts, ...settings.preferences.shortcuts },
  };
  const selectedSession = sessions.find((session) => session.id === selected);

  const refresh = useCallback(async () => {
    if (refreshRunning.current) return;
    refreshRunning.current = true;
    try {
      const result = await api.sessions();
      if (mounted.current) {
        setSessions((current) =>
          current.length === result.length &&
          current.every((s, i) => s.id === result[i].id && s.revision === result[i].revision)
            ? current
            : result,
        );
        setConnectionError("");
      }
    } catch (error) {
      if (mounted.current) setConnectionError(errorText(error));
    } finally {
      refreshRunning.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void api
      .info()
      .then((value) => {
        if (mounted.current) setInfo(value);
      })
      .catch((e) => {
        if (mounted.current) setConnectionError(errorText(e));
      });
    void api
      .settings()
      .then((value) => {
        if (mounted.current) {
          settingsRef.current = value;
          setSettings(value);
          setReady(true);
        }
      })
      .catch((e) => {
        if (mounted.current)
          setError(`Settings could not be loaded. Nothing will be overwritten. ${errorText(e)}`);
      });
    void refresh();
    const timer = setInterval(() => void refresh(), 350);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (prefs.theme === "system") delete document.documentElement.dataset.mode;
    else document.documentElement.dataset.mode = prefs.theme;
  }, [prefs.theme]);
  useEffect(() => {
    if (!selected && sessions.length) setSelected(sessions[0].id);
  }, [sessions, selected]);

  function persist(update: (current: Settings) => Settings): Promise<void> {
    if (!readyRef.current)
      return Promise.reject(
        Error("Settings are unavailable. Resolve the settings error before saving."),
      );
    const next = update(settingsRef.current);
    settingsRef.current = next;
    setSettings(next);
    const save = saveQueue.current.catch(() => {}).then(() => api.save(next));
    saveQueue.current = save;
    return save;
  }
  const updatePrefs = (next: Partial<Preferences>) =>
    persist((current) => ({ ...current, preferences: { ...current.preferences, ...next } }));
  async function saveConfig(config: LaunchConfig) {
    await persist((current) => ({
      ...current,
      launches: current.launches.some((c) => c.id === config.id)
        ? current.launches.map((c) => (c.id === config.id ? config : c))
        : [...current.launches, config],
    }));
  }
  async function start(config: LaunchConfig) {
    await saveConfig(config);
    const session = await api.start(config);
    setSelected(session.id);
    await refresh();
  }
  async function saveBreakpoints(session: Session, path: string, items: Breakpoint[]) {
    await persist((current) => ({
      ...current,
      launches: current.launches.map((config) =>
        config.id === session.configId
          ? { ...config, breakpoints: { ...config.breakpoints, [path]: items } }
          : config,
      ),
    }));
  }
  function requestQuit() {
    const external = sessions.some((session) => active(session) && session.kind === "endpoint");
    setConfirmation({
      title: "Close Lantern?",
      description: `App-launched targets will stop. ${external ? "External sessions will disconnect. Their server settings can terminate a target or leave it paused; Lantern cannot guarantee otherwise." : "Saved configurations and preferences remain on this machine."}`,
      label: "Stop sessions and close",
      action: () => api.quit(),
    });
  }
  useEffect(() => Events.On("lantern:close-requested", requestQuit), [sessions]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (matchesShortcut(event, prefs.shortcuts.palette)) {
        event.preventDefault();
        setPalette((value) => !value);
        setQuery("");
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [prefs.shortcuts.palette]);
  function restart(session: Session) {
    const config = settingsRef.current.launches.find((config) => config.id === session.configId);
    if (!config) {
      setError("The launch configuration is no longer available.");
      return;
    }
    setConfirmation({
      title: "Restart this target?",
      description:
        "Lantern will stop the current target, rebuild when needed, and launch a new session. Other sessions will not be affected.",
      label: "Restart target",
      action: async () => {
        await restartSession(session.id, {
          disconnect: api.disconnect,
          remove: api.remove,
          start: () => start({ ...config, breakpoints: session.breakpoints }),
          refresh,
        }).catch((error) => {
          setSelected(sessions.find((item) => item.id !== session.id)?.id || "");
          throw error;
        });
      },
    });
  }
  async function remove(session: Session) {
    const doRemove = async () => {
      if (active(session)) await api.disconnect(session.id, session.kind === "launch");
      await api.remove(session.id);
      if (selected === session.id) setSelected("");
      await refresh();
    };
    if (active(session))
      setConfirmation({
        title:
          session.kind === "launch" ? "Stop and close this session?" : "Disconnect this session?",
        description:
          session.kind === "launch"
            ? "The target and its Delve adapter will stop. Other sessions are not affected."
            : "The external server determines whether the target resumes, remains paused, or exits. Use a persistent multi-client Delve server when preservation matters.",
        label: "Close session",
        action: doRemove,
      });
    else await doRemove();
  }
  const commands = [
    { name: "New debug session", action: () => setLaunch({}) },
    { name: "Settings", action: () => setShowSettings(true) },
    ...settings.launches.map((config) => ({
      name: `Launch: ${config.name}`,
      action: () => void start(config).catch((e) => setError(errorText(e))),
    })),
    ...sessions.map((session) => ({
      name: `Switch session: ${session.name}`,
      action: () => setSelected(session.id),
    })),
  ].filter((command) => command.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="wordmark">
          <BugBeetle aria-hidden="true" size={20} />
          <h1>Lantern</h1>
        </div>
        <span className="header-context">Debugger</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Command palette"
            title={`Command palette (${prefs.shortcuts.palette})`}
            onClick={() => {
              setQuery("");
              setPalette(true);
            }}
          >
            <Command aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Settings"
            title="Settings"
            disabled={!ready}
            onClick={() => setShowSettings(true)}
          >
            <Gear aria-hidden="true" />
          </Button>
          <span className="toolbar-divider" />
          <Button
            size="sm"
            aria-label="New session"
            disabled={!ready}
            onClick={() => setLaunch({})}
          >
            <Plus aria-hidden="true" />
            <span className="hidden min-[521px]:inline">New session</span>
            <span className="min-[521px]:hidden">New</span>
          </Button>
        </div>
      </header>
      {connectionError && (
        <div className="inline-error" role="alert">
          <WarningCircle aria-hidden="true" />
          <span>Desktop connection unavailable. {connectionError}</span>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <WarningCircle aria-hidden="true" />
          <span>{error}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}
      {sessions.length > 0 && (
        <div className="session-bar" role="region" aria-label="Debug sessions">
          <label className="flex min-w-0 items-center gap-3">
            <span className="text-xs text-muted-foreground">Session</span>
            <select
              aria-label="Active debug session"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name} · {session.state}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs text-muted-foreground">
            {sessions.filter(active).length} active
          </span>
          {selectedSession && (
            <Button
              className="ml-auto"
              size="icon-sm"
              variant="ghost"
              aria-label="Close selected session"
              onClick={() => void remove(selectedSession).catch((e) => setError(errorText(e)))}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      <main className="app-main">
        <Suspense fallback={<div className="source-placeholder">Opening workspace…</div>}>
          {sessions.length === 0 ? (
            <div className="empty-workspace">
              <aside className="saved-configs">
                <div className="panel-heading">
                  <h2>Configurations</h2>
                  <span className="text-xs text-muted-foreground">{settings.launches.length}</span>
                </div>
                {settings.launches.length === 0 ? (
                  <p className="panel-note">Saved launch configurations appear here.</p>
                ) : (
                  settings.launches.map((config) => (
                    <div className="saved-config" key={config.id}>
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setLaunch({ initial: config })}
                      >
                        <span className="block truncate">{config.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {config.kind === "endpoint"
                            ? config.endpoint
                            : config.mode === "test"
                              ? "Go test package"
                              : "Go target"}
                        </span>
                      </button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Launch ${config.name}`}
                        onClick={() => void start(config).catch((e) => setError(errorText(e)))}
                      >
                        <Play aria-hidden="true" />
                      </Button>
                    </div>
                  ))
                )}
              </aside>
              <section className="empty-center">
                <div className="empty-content">
                  <h2>No debug session</h2>
                  <p>
                    Launch a Go package, test, or executable, or connect to a local Delve endpoint.
                  </p>
                  <Button disabled={!ready} onClick={() => setLaunch({})}>
                    <Plus aria-hidden="true" />
                    New session
                  </Button>
                  <div className="setup-status">
                    <span
                      className={`state-indicator ${info?.delve ? "state-running" : "state-failed"}`}
                    />
                    <span>
                      {info
                        ? info.delve
                          ? `Delve available at ${info.delve}`
                          : "Install Delve or choose its executable in a launch configuration."
                        : "Connecting to desktop…"}
                    </span>
                  </div>
                  <p className="empty-footnote">
                    Source stays read-only. Keep writing code in your editor.
                  </p>
                </div>
              </section>
            </div>
          ) : (
            sessions.map((session) => (
              <Workspace
                key={session.id}
                session={session}
                visible={selected === session.id}
                config={settings.launches.find((config) => config.id === session.configId)}
                prefs={prefs}
                onPrefs={(next) => void updatePrefs(next).catch((e) => setError(errorText(e)))}
                onBreakpoints={saveBreakpoints}
                onRestart={restart}
                onError={setError}
                refresh={refresh}
              />
            ))
          )}
        </Suspense>
      </main>
      <footer className="status-bar">
        <span>{info ? "Local" : "Connecting"}</span>
        <span className="status-separator" />
        <span>Go / Delve</span>
        <span className="ml-auto">{info?.os || ""}</span>
        <span>{info?.version || ""}</span>
      </footer>
      {launch && (
        <LaunchDialog
          open
          initial={launch.initial}
          onClose={() => setLaunch(null)}
          onLaunch={start}
          onSave={saveConfig}
        />
      )}
      {showSettings && (
        <SettingsDialog prefs={prefs} onSave={updatePrefs} onClose={() => setShowSettings(false)} />
      )}
      <Dialog open={palette} onOpenChange={setPalette}>
        <DialogContent className="gap-3">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Command palette</DialogTitle>
            <DialogDescription className="sr-only">
              Find a command, launch configuration, or session.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="Find command"
            placeholder="Find a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && commands[0]) {
                setPalette(false);
                commands[0].action();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                document.querySelector<HTMLButtonElement>("[data-palette-command]")?.focus();
              }
            }}
          />
          <div className="palette-list">
            {commands.map((command) => (
              <button
                key={command.name}
                data-palette-command
                className="palette-command"
                onClick={() => {
                  setPalette(false);
                  command.action();
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const button =
                      event.key === "ArrowDown"
                        ? event.currentTarget.nextElementSibling
                        : event.currentTarget.previousElementSibling;
                    (button as HTMLButtonElement | null)?.focus();
                  }
                }}
              >
                {command.name}
                <ArrowRight aria-hidden="true" />
              </button>
            ))}
            {!commands.length && <p className="panel-note">No matching commands.</p>}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !confirmBusy) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">{confirmation?.title}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {confirmation?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={confirmBusy} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmBusy}
              aria-busy={confirmBusy}
              onClick={() => {
                setConfirmBusy(true);
                void confirmation
                  ?.action()
                  .then(() => setConfirmation(null))
                  .catch((e) => setError(errorText(e)))
                  .finally(() => setConfirmBusy(false));
              }}
            >
              {confirmBusy ? "Working…" : confirmation?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
