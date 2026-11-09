export interface Breakpoint {
  line: number;
  condition: string;
  hitCondition: string;
  logMessage: string;
  verified: boolean;
  message: string;
  id: number;
}
export interface LaunchConfig {
  id: string;
  name: string;
  kind: "launch" | "endpoint";
  mode: "debug" | "test" | "exec";
  program: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  buildFlags: string;
  endpoint: string;
  delvePath: string;
  stopOnEntry: boolean;
  breakpoints: Record<string, Breakpoint[]>;
}
export interface Capabilities {
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsLogPoints?: boolean;
  supportsRestartRequest?: boolean;
}
export interface Session {
  id: string;
  name: string;
  configId: string;
  kind: "launch" | "endpoint";
  state:
    | "starting"
    | "disconnecting"
    | "running"
    | "stopped"
    | "terminated"
    | "disconnected"
    | "failed";
  reason: string;
  error: string;
  threadId: number;
  generation: number;
  revision: number;
  capabilities: Capabilities;
  breakpoints: Record<string, Breakpoint[]>;
  output: { id: number; category: string; text: string }[];
  outputDropped: boolean;
}
export interface StopRef {
  sessionId: string;
  generation: number;
}
export interface Thread {
  id: number;
  name: string;
}
export interface Source {
  path?: string;
  name?: string;
  sourceReference?: number;
}
export interface Frame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: Source;
}
export interface Scope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  namedVariables?: number;
  indexedVariables?: number;
}
export interface Variable {
  name: string;
  value: string;
  type?: string;
  evaluateName?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}
export interface VariablePage {
  variables: Variable[];
  more: boolean;
}
export interface Evaluation {
  result: string;
  type?: string;
  variablesReference: number;
}
export interface SourceFile {
  path: string;
  content: string;
  hash: string;
}
export interface FileList {
  root: string;
  paths: string[];
  truncated: boolean;
}
export type Theme = "system" | "light" | "dark";
export interface Preferences {
  theme: Theme;
  watches: string[];
  editorCommand: string[];
  shortcuts: Record<string, string>;
  layout?: Record<string, number>;
}
export interface Settings {
  version: 1;
  launches: LaunchConfig[];
  preferences: Partial<Preferences>;
}
export const emptyConfig = (): LaunchConfig => ({
  id: crypto.randomUUID(),
  name: "",
  kind: "launch",
  mode: "debug",
  program: "",
  cwd: "",
  args: [],
  env: {},
  buildFlags: "",
  endpoint: "127.0.0.1:38697",
  delvePath: "",
  stopOnEntry: false,
  breakpoints: {},
});
export const active = (s: Session) => !["terminated", "disconnected", "failed"].includes(s.state);
export const stopRef = (s: Session): StopRef => ({ sessionId: s.id, generation: s.generation });
export const basename = (path: string) => path.split(/[\\/]/).at(-1) || path;
