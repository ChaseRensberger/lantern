import type { Variable, SourceFile } from "./types";

export function cacheSource(
  current: Record<string, SourceFile>,
  source: SourceFile,
): Record<string, SourceFile> {
  const recent = Object.entries(current)
    .filter(([path]) => path !== source.path)
    .slice(-11);
  return { ...Object.fromEntries(recent), [source.path]: source };
}

export interface PauseData<T> {
  key: string;
  data: T;
}
export function dataForPause<T>(value: PauseData<T> | null, key: string): T | undefined {
  return value?.key === key ? value.data : undefined;
}

// Adapter variable handles and frame IDs are pause-local. Never use them as
// cross-pause identities for changed-value highlighting.
export class ObservedValues {
  private context = "";
  private generation = -1;
  private current = new Map<string, string>();
  private previous = new Map<string, string>();
  begin(context: string, generation: number) {
    if (context !== this.context) {
      this.current.clear();
      this.previous.clear();
      this.context = context;
    } else if (generation !== this.generation) {
      this.previous = this.current;
      this.current = new Map();
    }
    this.generation = generation;
  }
  observe(path: string, variable: Variable): boolean {
    const value = `${variable.type || ""}\u0000${variable.value}`;
    const changed = this.previous.has(path) && this.previous.get(path) !== value;
    if (this.current.size < 2000) this.current.set(path, value);
    return changed;
  }
}

export function parseEditorCommand(input: string): string[] {
  const value: unknown = JSON.parse(input);
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string") ||
    (value.length > 0 && !value[0])
  )
    throw Error("Editor command must be a JSON array of arguments.");
  if (value.length > 0 && !value.some((item) => item.includes("{file}")))
    throw Error("Include {file} as an editor argument.");
  return value as string[];
}

// Hover evaluation accepts identifier paths only, never calls or arbitrary
// expressions inferred from source text.
export function hoverExpression(
  text: string,
  offset: number,
): { text: string; from: number; to: number } | null {
  const pattern = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
  for (const match of text.matchAll(pattern)) {
    const from = match.index,
      to = from + match[0].length;
    if (offset >= from && offset <= to) return { text: match[0], from, to };
  }
  return null;
}
