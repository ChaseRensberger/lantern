import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  ArrowBendDownRight,
  ArrowDown,
  ArrowUp,
  ArrowClockwise,
  ArrowSquareOut,
  CaretRight,
  FileCode,
  Pause,
  Play,
  Stop,
  X,
  PencilSimple,
  Sidebar,
  SidebarSimple,
  TerminalWindow,
} from "@phosphor-icons/react";
import { Button } from "./core/button";
import { Input } from "./core/input";
import { Checkbox } from "./core/checkbox";
import type { SourceViewHandle } from "./source-view";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "./core/dialog";
import { Inspector } from "./inspector";
import { BreakpointDialog } from "./breakpoint-dialog";
import { api, errorText } from "../lib/api";
import {
  active as isLive,
  basename,
  stopRef,
  type Breakpoint,
  type FileList,
  type Frame,
  type LaunchConfig,
  type Preferences,
  type Scope,
  type Session,
  type SourceFile,
  type Thread,
} from "../lib/types";
import { ObservedValues, dataForPause, cacheSource, type PauseData } from "../lib/inspection";
import { useMedia } from "../lib/use-media";
import { SourceBaseline } from "../lib/source-baseline";
import { defaultShortcuts, matchesShortcut } from "../lib/shortcuts";
const SourceView = lazy(() =>
  import("./source-view").then((module) => ({ default: module.SourceView })),
);
const noThreads: Thread[] = [];
const noFrames: Frame[] = [];
const noScopes: Scope[] = [];

interface Props {
  session: Session;
  visible: boolean;
  config?: LaunchConfig;
  prefs: Preferences;
  onPrefs: (next: Partial<Preferences>) => void;
  onBreakpoints: (session: Session, path: string, items: Breakpoint[]) => Promise<void>;
  onRestart: (session: Session) => void;
  onError: (error: string) => void;
  refresh: () => Promise<void>;
}
export function Workspace({
  session,
  visible,
  config,
  prefs,
  onPrefs,
  onBreakpoints,
  onRestart,
  onError,
  refresh,
}: Props) {
  const [threadData, setThreadData] = useState<PauseData<Thread[]> | null>(null);
  const [frameData, setFrameData] = useState<PauseData<Frame[]> | null>(null);
  const [scopeData, setScopeData] = useState<PauseData<Scope[]> | null>(null);
  const [thread, setThread] = useState(0),
    [frameIndex, setFrameIndex] = useState(0);
  const [stackError, setStackError] = useState("");
  const [files, setFiles] = useState<FileList>({ root: "", paths: [], truncated: false }),
    [fileFilter, setFileFilter] = useState("");
  const [path, setPath] = useState(""),
    [sources, setSources] = useState<Record<string, SourceFile>>({}),
    [tabs, setTabs] = useState<string[]>([]),
    [sourceError, setSourceError] = useState("");
  const [cursor, setCursor] = useState(1),
    [sourceChanged, setSourceChanged] = useState(false);
  const [busy, setBusy] = useState(false),
    [editPoint, setEditPoint] = useState<{ path: string; point: Breakpoint } | null>(null);
  const [showNav, setShowNav] = useState(true),
    [showInspector, setShowInspector] = useState(true),
    [showOutput, setShowOutput] = useState(true);
  const narrow = useMedia("(max-width: 800px)");
  const [compactPanel, setCompactPanel] = useState<
    "source" | "navigation" | "inspector" | "output"
  >("source");
  const navigationVisible = narrow ? compactPanel === "navigation" : showNav;
  const inspectorVisible = narrow ? compactPanel === "inspector" : showInspector;
  const outputVisible = narrow ? compactPanel === "output" : showOutput;
  const centerVisible = !narrow || compactPanel === "source" || compactPanel === "output";
  const [followOutput, setFollowOutput] = useState(true);
  const [goToLine, setGoToLine] = useState(false),
    [targetLine, setTargetLine] = useState("1");
  const sourceView = useRef<SourceViewHandle>(null);
  const output = useRef<HTMLPreElement>(null);
  const observed = useRef(new ObservedValues());
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const breakpointQueue = useRef(Promise.resolve());
  const pendingBreakpoints = useRef(new Map<string, Breakpoint[]>());
  const expansion = useRef(new Map<string, Set<string>>());
  const sourceRef = useRef(sources);
  const sourceBaseline = useRef(new SourceBaseline());
  sourceRef.current = sources;
  const tabID = useId();
  const paused = session.state === "stopped";
  const currentKey = `${session.id}/${session.generation}`;
  const threads = dataForPause(threadData, currentKey) || noThreads;
  const stackKey = `${currentKey}/${thread}`;
  const frames = dataForPause(frameData, stackKey) || noFrames;
  const frame = frames[frameIndex];
  const scopeKey = `${stackKey}/${frame?.id}`;
  const scopes = dataForPause(scopeData, scopeKey) || noScopes;

  useEffect(() => {
    let stale = false;
    void api
      .files(session.id)
      .then((result) => {
        if (!stale) {
          setFiles(result);
          const first = result.paths.find((p) => basename(p) === "main.go") || result.paths[0];
          if (first) setPath(first);
        }
      })
      .catch((e) => {
        if (!stale) setSourceError(errorText(e));
      });
    return () => {
      stale = true;
    };
  }, [session.id]);
  useEffect(() => {
    let stale = false;
    setStackError("");
    if (paused)
      void api
        .threads(stopRef(session))
        .then((result) => {
          if (stale) return;
          setThreadData({ key: currentKey, data: result });
          setThread(
            result.some((t) => t.id === session.threadId) ? session.threadId : result[0]?.id || 0,
          );
        })
        .catch((e) => {
          if (!stale) setStackError(errorText(e));
        });
    return () => {
      stale = true;
    };
  }, [currentKey, paused]);
  useEffect(() => {
    let stale = false;
    setFrameIndex(0);
    if (paused && thread && threads.some((item) => item.id === thread))
      void api
        .stack(stopRef(session), thread)
        .then((result) => {
          if (!stale) {
            setStackError("");
            setFrameData({ key: stackKey, data: result });
            if (result[0]?.source?.path) setPath(result[0].source.path);
          }
        })
        .catch((e) => {
          if (!stale) setStackError(errorText(e));
        });
    return () => {
      stale = true;
    };
  }, [stackKey, threads, paused]);
  useEffect(() => {
    let stale = false;
    if (paused && frame)
      void api
        .scopes(stopRef(session), frame.id)
        .then((result) => {
          if (!stale) setScopeData({ key: scopeKey, data: result });
        })
        .catch((e) => {
          if (!stale) setStackError(errorText(e));
        });
    return () => {
      stale = true;
    };
  }, [scopeKey, paused]);
  useEffect(() => {
    let stale = false;
    setSourceError("");
    setSourceChanged(sourceBaseline.current.hasChanged(path));
    if (path) {
      setTabs((current) => (current.includes(path) ? current : [...current.slice(-11), path]));
      if (!sourceRef.current[path])
        void api
          .source(session.id, path)
          .then((source) => {
            if (!stale) {
              setSourceChanged(sourceBaseline.current.observe(path, source.hash));
              setSources((current) => cacheSource(current, source));
            }
          })
          .catch((e) => {
            if (!stale) setSourceError(errorText(e));
          });
    }
    return () => {
      stale = true;
    };
  }, [session.id, path]);
  useEffect(() => {
    if (!visible || !path) return;
    let stale = false,
      inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void api
        .source(session.id, path)
        .then((source) => {
          if (!stale && sourceRef.current[path])
            setSourceChanged(sourceBaseline.current.observe(path, source.hash));
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    }, 2000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [session.id, path, visible]);
  useEffect(() => {
    if (followOutput && visible) output.current?.scrollTo({ top: output.current.scrollHeight });
  }, [session.revision, followOutput, visible]);

  async function run(command: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api.execute(
        stopRef(sessionRef.current),
        command,
        thread || sessionRef.current.threadId,
      );
      await refresh();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function setPoints(sourcePath: string, items: Breakpoint[]) {
    pendingBreakpoints.current.set(sourcePath, items);
    const request = breakpointQueue.current
      .catch(() => {})
      .then(async () => {
        const result = await api.breakpoints(session.id, sourcePath, items);
        await onBreakpoints(session, sourcePath, result);
        await refresh();
      });
    breakpointQueue.current = request;
    try {
      await request;
    } finally {
      if (pendingBreakpoints.current.get(sourcePath) === items)
        pendingBreakpoints.current.delete(sourcePath);
    }
  }
  async function togglePoint(line: number) {
    if (!path) return;
    const points =
      pendingBreakpoints.current.get(path) || sessionRef.current.breakpoints[path] || [];
    try {
      await setPoints(
        path,
        points.some((p) => p.line === line)
          ? points.filter((p) => p.line !== line)
          : [
              ...points,
              {
                line,
                condition: "",
                hitCondition: "",
                logMessage: "",
                verified: false,
                message: "",
                id: 0,
              },
            ],
      );
    } catch (error) {
      onError(errorText(error));
    }
  }
  useEffect(() => {
    if (!visible) return;
    function keydown(event: KeyboardEvent) {
      if (document.querySelector('[role="dialog"][data-open]')) return;
      for (const command of ["continue", "next", "stepIn", "stepOut", "breakpoint"]) {
        if (matchesShortcut(event, prefs.shortcuts[command] || defaultShortcuts[command])) {
          event.preventDefault();
          if (command === "breakpoint") void togglePoint(cursor);
          else if (paused) void run(command);
          return;
        }
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [visible, prefs.shortcuts, paused, busy, path, cursor, thread]);

  const context = `${session.id}/${thread}/${frame?.name}/${frame?.source?.path}/${frameIndex}`;
  if (paused && frame) observed.current.begin(context, session.generation);
  const source = sources[path];
  const activeLine = paused && frame?.source?.path === path && !sourceChanged ? frame.line : 0;
  const points = Object.entries(session.breakpoints).flatMap(([path, items]) =>
    items.map((point) => ({ path, point })),
  );
  const filteredFiles = files.paths.filter((path) =>
    path.toLowerCase().includes(fileFilter.toLowerCase()),
  );
  const controls = [
    { command: "continue", label: "Continue", Icon: Play },
    { command: "next", label: "Step over", Icon: ArrowBendDownRight },
    { command: "stepIn", label: "Step into", Icon: ArrowDown },
    { command: "stepOut", label: "Step out", Icon: ArrowUp },
  ];

  return (
    <div className="session-workspace" hidden={!visible}>
      <div className="debug-toolbar" role="group" aria-label="Debugger controls">
        <div className="flex items-center gap-1" role="group" aria-label="Execution">
          {controls.map(({ command, label, Icon }) => (
            <Button
              key={command}
              size="icon-sm"
              variant="ghost"
              aria-label={label}
              title={`${label} (${prefs.shortcuts[command] || defaultShortcuts[command]})`}
              disabled={!paused || busy}
              onClick={() => void run(command)}
            >
              <Icon aria-hidden="true" />
            </Button>
          ))}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Pause"
            title="Pause"
            disabled={session.state !== "running" || busy}
            onClick={() => void run("pause")}
          >
            <Pause aria-hidden="true" />
          </Button>
          <span className="toolbar-divider" />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={session.kind === "launch" ? "Stop session" : "Disconnect session"}
            title={
              session.kind === "launch"
                ? "Stop target and adapter"
                : "Disconnect; external server policy applies"
            }
            disabled={!isLive(session) || busy}
            onClick={() => {
              setBusy(true);
              void api
                .disconnect(session.id, session.kind === "launch")
                .then(refresh)
                .catch((e) => onError(errorText(e)))
                .finally(() => setBusy(false));
            }}
          >
            <Stop aria-hidden="true" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Restart session"
            title="Stop and relaunch"
            disabled={session.kind !== "launch" || !config || busy}
            onClick={() => onRestart(session)}
          >
            <ArrowClockwise aria-hidden="true" />
          </Button>
        </div>
        <div className="session-status" role="status">
          <span className={`state-indicator state-${session.state}`} />
          <span>{session.state}</span>
          {session.reason && (
            <span className="truncate text-muted-foreground">{session.reason}</span>
          )}
        </div>
        <div className="ml-auto flex gap-1" role="group" aria-label="Panels">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle navigation"
            aria-pressed={navigationVisible}
            onClick={() =>
              narrow
                ? setCompactPanel(compactPanel === "navigation" ? "source" : "navigation")
                : setShowNav(!showNav)
            }
          >
            <Sidebar aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle inspector"
            aria-pressed={inspectorVisible}
            onClick={() =>
              narrow
                ? setCompactPanel(compactPanel === "inspector" ? "source" : "inspector")
                : setShowInspector(!showInspector)
            }
          >
            <SidebarSimple aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle output"
            aria-pressed={outputVisible}
            onClick={() =>
              narrow
                ? setCompactPanel(compactPanel === "output" ? "source" : "output")
                : setShowOutput(!showOutput)
            }
          >
            <TerminalWindow aria-hidden="true" />
          </Button>
        </div>
      </div>
      {session.error && (
        <div className="inline-error" role="alert">
          {session.error}
        </div>
      )}
      {sourceChanged && (
        <div className="source-warning" role="status">
          <span>Source changed on disk. The running binary may not match.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void api
                .source(session.id, path)
                .then((value) => {
                  setSources((current) => cacheSource(current, value));
                  setSourceChanged(sourceBaseline.current.observe(path, value.hash));
                })
                .catch((e) => onError(errorText(e)))
            }
          >
            Reload source
          </Button>
          {session.kind === "launch" && (
            <Button size="sm" variant="outline" onClick={() => onRestart(session)}>
              Restart target
            </Button>
          )}
        </div>
      )}
      <Group
        className="workspace-group"
        defaultLayout={narrow ? undefined : prefs.layout}
        onLayoutChanged={(layout, meta) => {
          if (!narrow && meta.isUserInteraction)
            onPrefs({ layout: meta.requestedLayout || layout });
        }}
      >
        {navigationVisible && (
          <>
            <Panel id="navigation" defaultSize="19%" minSize="160px" className="navigation-panel">
              <section className="navigation-section">
                <div className="panel-heading">
                  <h2>Files</h2>
                  <span className="text-xs text-muted-foreground">Go</span>
                </div>
                <div className="px-3 pb-2">
                  <Input
                    aria-label="Find file"
                    className="h-8"
                    placeholder="Find file…"
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                  />
                </div>
                <div className="file-list">
                  {filteredFiles.slice(0, 200).map((file) => (
                    <button
                      key={file}
                      className={`file-row ${path === file ? "selected" : ""}`}
                      title={file}
                      onClick={() => setPath(file)}
                    >
                      <FileCode aria-hidden="true" />
                      <span>{file.slice(files.root.length + 1)}</span>
                    </button>
                  ))}
                  {filteredFiles.length > 200 && (
                    <p className="panel-note">Showing 200 matches. Narrow the filename filter.</p>
                  )}
                  {files.truncated && (
                    <p className="panel-note">File listing reached its scan limit.</p>
                  )}
                  {!files.paths.length && (
                    <p className="panel-note">
                      {session.kind === "endpoint"
                        ? "Set a local source root, or select a paused stack frame."
                        : "No Go source files found."}
                    </p>
                  )}
                </div>
              </section>
              <section className="navigation-section">
                <div className="panel-heading">
                  <h2>Call stack</h2>
                </div>
                {paused && threads.length > 0 && (
                  <div className="px-3 pb-2">
                    <label className="sr-only" htmlFor={`${tabID}-goroutines`}>
                      Goroutine
                    </label>
                    <select
                      id={`${tabID}-goroutines`}
                      className="w-full"
                      value={thread}
                      onChange={(e) => setThread(Number(e.target.value))}
                    >
                      {threads.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="stack-list">
                  {frames.map((item, index) => (
                    <button
                      key={`${item.id}/${index}`}
                      className={`stack-row ${frameIndex === index ? "selected" : ""}`}
                      title={`${item.name}\n${item.source?.path || "No source"}:${item.line}`}
                      onClick={() => {
                        setFrameIndex(index);
                        if (item.source?.path) setPath(item.source.path);
                      }}
                    >
                      <CaretRight aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate">{item.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {basename(item.source?.path || "No source")}:{item.line}
                        </span>
                      </span>
                    </button>
                  ))}
                  {!paused && <p className="panel-note">Pause the target to inspect its stack.</p>}
                  {stackError && (
                    <p className="panel-note text-warning">
                      {stackError}. If paused before runtime initialization, continue to a source
                      breakpoint.
                    </p>
                  )}
                </div>
              </section>
              <section className="navigation-section">
                <div className="panel-heading">
                  <h2>Breakpoints</h2>
                  <span className="text-xs text-muted-foreground">{points.length}</span>
                </div>
                {points.map(({ path: bpPath, point }) => (
                  <div className="breakpoint-row" key={`${bpPath}/${point.line}`}>
                    <button
                      className="min-w-0 flex-1 truncate text-left text-xs"
                      title={`${bpPath}:${point.line}\n${point.verified ? "Verified" : point.message || "Unverified"}`}
                      onClick={() => setPath(bpPath)}
                    >
                      <span className={point.verified ? "text-link" : "text-warning"}>
                        {point.verified ? "●" : "○"}
                      </span>{" "}
                      {basename(bpPath)}:{point.line}
                      {point.logMessage ? " · log" : ""}
                    </button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Edit breakpoint at ${basename(bpPath)} line ${point.line}`}
                      onClick={() => setEditPoint({ path: bpPath, point })}
                    >
                      <PencilSimple aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove breakpoint at ${basename(bpPath)} line ${point.line}`}
                      onClick={() =>
                        void setPoints(
                          bpPath,
                          (session.breakpoints[bpPath] || []).filter((p) => p.line !== point.line),
                        ).catch((e) => onError(errorText(e)))
                      }
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                ))}
                {points.length === 0 && (
                  <p className="panel-note">
                    Click the source gutter or use {prefs.shortcuts.breakpoint || "F9"} to set a
                    breakpoint.
                  </p>
                )}
              </section>
            </Panel>
            {!narrow && <Separator className="panel-separator" aria-label="Resize navigation" />}
          </>
        )}
        {centerVisible && (
          <Panel id="source" minSize="200px" className="center-panel">
            <Group orientation="vertical">
              {(!narrow || compactPanel === "source") && (
                <Panel id="code" defaultSize="72%" minSize="160px" className="code-panel">
                  <div className="source-tabs" role="tablist" aria-label="Open source files">
                    {tabs.map((tab, index) => (
                      <button
                        role="tab"
                        id={`${tabID}-tab-${index}`}
                        aria-controls={`${tabID}-source`}
                        aria-selected={tab === path}
                        tabIndex={tab === path ? 0 : -1}
                        className={`source-tab ${tab === path ? "selected" : ""}`}
                        key={tab}
                        title={tab}
                        onClick={() => setPath(tab)}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                            event.preventDefault();
                            const target =
                              tabs[
                                (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                                  tabs.length
                              ];
                            setPath(target);
                            document
                              .getElementById(`${tabID}-tab-${tabs.indexOf(target)}`)
                              ?.focus();
                          }
                        }}
                      >
                        <FileCode aria-hidden="true" />
                        {basename(tab)}
                      </button>
                    ))}
                  </div>
                  <div className="source-path">
                    <span title={path}>{path || "No source selected"}</span>
                    {path && (
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Go to line"
                          title="Go to line"
                          onClick={() => {
                            setTargetLine(String(cursor));
                            setGoToLine(true);
                          }}
                        >
                          Ln {cursor}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Open source in editor"
                          title="Open in configured editor"
                          onClick={() =>
                            void api
                              .openEditor(session.id, path, activeLine || cursor)
                              .catch((e) => onError(errorText(e)))
                          }
                        >
                          <ArrowSquareOut aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </div>
                  <div
                    id={`${tabID}-source`}
                    role="tabpanel"
                    aria-labelledby={
                      tabs.includes(path) ? `${tabID}-tab-${tabs.indexOf(path)}` : undefined
                    }
                    aria-label={!tabs.includes(path) ? "Source" : undefined}
                    className="source-container"
                  >
                    <Suspense
                      fallback={<div className="source-placeholder">Loading source viewer…</div>}
                    >
                      {source ? (
                        <SourceView
                          ref={sourceView}
                          source={source}
                          line={activeLine}
                          breakpoints={session.breakpoints[path] || []}
                          onToggle={(line) => void togglePoint(line)}
                          onCursor={setCursor}
                          active={visible}
                          hoverKey={`${currentKey}/${frame?.id}`}
                          onHover={
                            paused && frame && frame.source?.path === path && !sourceChanged
                              ? (expression) => api.evaluate(stopRef(session), frame.id, expression)
                              : undefined
                          }
                        />
                      ) : (
                        <div className="source-placeholder">
                          {sourceError ||
                            (path ? "Loading source…" : "Select a file or a paused stack frame.")}
                        </div>
                      )}
                    </Suspense>
                  </div>
                </Panel>
              )}
              {outputVisible && (
                <>
                  {!narrow && <Separator className="panel-separator" aria-label="Resize output" />}
                  <Panel id="output" defaultSize="28%" minSize="100px" className="output-panel">
                    <div className="panel-heading">
                      <h2>Output</h2>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox checked={followOutput} onCheckedChange={setFollowOutput} />
                        Follow
                      </label>
                    </div>
                    {session.kind === "endpoint" && (
                      <p className="panel-note">
                        Target output stays in its original terminal. Adapter messages appear here.
                      </p>
                    )}
                    {session.outputDropped && (
                      <p className="panel-note text-warning">
                        Earlier output was discarded. The buffer is limited to 256 KiB.
                      </p>
                    )}
                    <pre
                      ref={output}
                      className="output-content"
                      role="region"
                      tabIndex={0}
                      aria-label="Program and adapter output"
                    >
                      {session.output.map((entry) => (
                        <span
                          key={entry.id}
                          className={entry.category === "stderr" ? "text-destructive" : undefined}
                        >
                          {entry.text}
                        </span>
                      ))}
                    </pre>
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
        )}
        {inspectorVisible && (
          <>
            {!narrow && <Separator className="panel-separator" aria-label="Resize inspector" />}
            <Panel id="inspector" defaultSize="25%" minSize="220px" className="inspector-panel">
              {paused && frame && scopes.length > 0 ? (
                <Inspector
                  key={`${currentKey}/${frame.id}`}
                  refAtStop={stopRef(session)}
                  frame={frame}
                  scopes={scopes}
                  watches={prefs.watches}
                  onWatches={(watches) => onPrefs({ watches })}
                  observed={observed.current}
                  initialExpansion={expansion.current.get(context)}
                  onExpansion={(paths) => {
                    if (expansion.current.size >= 64 && !expansion.current.has(context))
                      expansion.current.delete(expansion.current.keys().next().value!);
                    expansion.current.set(context, paths);
                  }}
                />
              ) : (
                <aside className="inspector">
                  <div className="panel-heading">
                    <h2>Inspector</h2>
                  </div>
                  <p className="panel-note">
                    {paused
                      ? "Select a stack frame to inspect its variables."
                      : "Variables and watches are available while the target is paused."}
                  </p>
                </aside>
              )}
            </Panel>
          </>
        )}
      </Group>
      {editPoint && (
        <BreakpointDialog
          point={editPoint.point}
          path={editPoint.path}
          caps={session.capabilities}
          onClose={() => setEditPoint(null)}
          onSave={(point) =>
            setPoints(
              editPoint.path,
              (session.breakpoints[editPoint.path] || []).map((p) =>
                p.line === editPoint.point.line ? point : p,
              ),
            )
          }
        />
      )}
      <Dialog open={goToLine} onOpenChange={setGoToLine}>
        <DialogContent className="max-w-sm">
          <DialogTitle className="text-base font-semibold">Go to line</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {basename(path)}
          </DialogDescription>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const line = Number(targetLine);
              if (Number.isInteger(line) && line > 0) {
                setGoToLine(false);
                requestAnimationFrame(() => sourceView.current?.jump(line));
              }
            }}
          >
            <label className="field">
              Line number
              <Input
                autoFocus
                type="number"
                min={1}
                step={1}
                required
                value={targetLine}
                onChange={(e) => setTargetLine(e.target.value)}
              />
            </label>
            <DialogFooter>
              <Button type="submit">Go to line</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
