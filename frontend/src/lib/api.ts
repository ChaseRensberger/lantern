import { Call } from "@wailsio/runtime";
import type {
  Breakpoint,
  Evaluation,
  FileList,
  Frame,
  LaunchConfig,
  Scope,
  Session,
  Settings,
  SourceFile,
  StopRef,
  Thread,
  VariablePage,
} from "./types";

// Keep the desktop boundary in one module. Components never speak DAP or
// import shell-specific APIs directly. The Go core remains the source of truth.
function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return Call.ByName(`lantern/internal/desktop.Service.${method}`, ...args);
}
export const api = {
  copy: async (text: string) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        /* Native webviews may require the platform clipboard. */
      }
    }
    await call<void>("CopyText", text);
  },
  info: () => call<{ os: string; delve: string; version: string }>("Info"),
  settings: () => call<Settings>("LoadSettings"),
  save: (settings: Settings) => call<void>("SaveSettings", settings),
  sessions: () => call<Session[]>("Sessions"),
  start: (config: LaunchConfig) => call<Session>("Start", config),
  remove: (id: string) => call<void>("Remove", id),
  threads: (ref: StopRef) => call<Thread[]>("Threads", ref),
  stack: (ref: StopRef, thread: number) => call<Frame[]>("Stack", ref, thread),
  scopes: (ref: StopRef, frame: number) => call<Scope[]>("Scopes", ref, frame),
  variables: (ref: StopRef, reference: number, start = 0, filter = "") =>
    call<VariablePage>("Variables", ref, reference, start, filter),
  evaluate: (ref: StopRef, frame: number, expression: string) =>
    call<Evaluation>("Evaluate", ref, frame, expression),
  execute: (ref: StopRef, command: string, thread: number) =>
    call<void>("Execute", ref, command, thread),
  breakpoints: (id: string, path: string, items: Breakpoint[]) =>
    call<Breakpoint[]>("Breakpoints", id, path, items),
  source: (id: string, path: string) => call<SourceFile>("Source", id, path),
  files: (id: string) => call<FileList>("Files", id),
  disconnect: (id: string, terminate: boolean) => call<void>("Disconnect", id, terminate),
  openEditor: (id: string, path: string, line: number) =>
    call<void>("OpenInEditor", id, path, line),
  choose: (directory: boolean) => call<string>("ChooseProgram", directory),
  quit: () => call<void>("Quit"),
};
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
