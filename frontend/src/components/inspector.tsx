import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretRight, Copy, Plus, X } from "@phosphor-icons/react";
import { Button } from "./core/button";
import { Input } from "./core/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./core/dialog";
import { api, errorText } from "../lib/api";
import type { Frame, Scope, StopRef, Variable } from "../lib/types";
import { ObservedValues } from "../lib/inspection";

type Node = { path: string; variable: Variable; depth: number; scope?: boolean };
type Loaded = {
  items: Variable[];
  more: boolean;
  reference: number;
  indexed: boolean;
  error?: string;
};

export function Inspector({
  refAtStop,
  frame,
  scopes,
  watches,
  onWatches,
  observed,
  initialExpansion,
  onExpansion,
}: {
  refAtStop: StopRef;
  frame: Frame;
  scopes: Scope[];
  watches: string[];
  onWatches: (items: string[]) => void;
  observed: ObservedValues;
  initialExpansion?: Set<string>;
  onExpansion: (paths: Set<string>) => void;
}) {
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    initialExpansion
      ? new Set(initialExpansion)
      : new Set(scopes.filter((s) => !s.expensive).map((s) => s.name)),
  );
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Variable | null>(null);
  const [copyError, setCopyError] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(320);
  const alive = useRef(true);
  const inFlight = useRef(new Map<string, symbol>());
  const viewport = useRef<HTMLDivElement>(null);
  const [watchInput, setWatchInput] = useState("");
  const [watchValues, setWatchValues] = useState<
    Record<string, { value?: Variable; error?: string }>
  >({});
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  function updateLoaded(update: (current: Record<string, Loaded>) => Record<string, Loaded>) {
    const next = update(loadedRef.current);
    loadedRef.current = next;
    setLoaded(next);
  }

  async function load(path: string, reference: number, more = false, indexed = false) {
    if (inFlight.current.has(path) || reference <= 0) return;
    const retained = Object.values(loadedRef.current).reduce(
      (sum, page) => sum + page.items.length,
      0,
    );
    if (retained + inFlight.current.size * 100 >= 2000) {
      updateLoaded((current) => ({
        ...current,
        [path]: {
          items: current[path]?.items || [],
          more: false,
          reference,
          indexed,
          error:
            "The 2,000-value inspection limit was reached. Collapse another branch, then retry.",
        },
      }));
      return;
    }
    const ticket = Symbol(path);
    inFlight.current.set(path, ticket);
    setLoading((current) => new Set(current).add(path));
    const start = more ? loadedRef.current[path]?.items.length || 0 : 0;
    try {
      const page = await api.variables(refAtStop, reference, start, indexed ? "indexed" : "");
      if (!alive.current || inFlight.current.get(path) !== ticket) return;
      updateLoaded((current) => {
        const previous = more ? current[path]?.items || [] : [];
        const duplicate =
          previous.length > 0 &&
          page.variables.length > 0 &&
          page.variables.every((value) => previous.some((old) => old.name === value.name));
        return {
          ...current,
          [path]: {
            items: duplicate ? previous : [...previous, ...page.variables],
            more: !duplicate && page.more,
            reference,
            indexed,
            error: duplicate
              ? "The adapter did not advance this page. Additional values are unavailable."
              : undefined,
          },
        };
      });
    } catch (error) {
      if (alive.current && inFlight.current.get(path) === ticket)
        updateLoaded((current) => ({
          ...current,
          [path]: {
            items: current[path]?.items || [],
            more: false,
            reference,
            indexed,
            error: errorText(error),
          },
        }));
    } finally {
      if (inFlight.current.get(path) === ticket) {
        inFlight.current.delete(path);
        if (alive.current)
          setLoading((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    for (const scope of scopes)
      if (!scope.expensive) void load(scope.name, scope.variablesReference);
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    // Restore expansion intent, never old DAP handles or captured values.
    for (const scope of scopes)
      if (expanded.has(scope.name) && !loaded[scope.name])
        void load(scope.name, scope.variablesReference);
    for (const [parent, page] of Object.entries(loaded))
      if (expanded.has(parent))
        for (const variable of page.items) {
          const path = `${parent}/${variable.name}`;
          if (expanded.has(path) && !loaded[path] && path.split("/").length <= 8)
            void load(
              path,
              variable.variablesReference,
              false,
              (variable.indexedVariables || 0) > 0,
            );
        }
  }, [loaded, expanded]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setWatchValues({});
    void (async () => {
      for (const expression of watches.slice(0, 32)) {
        try {
          const result = await api.evaluate(refAtStop, frame.id, expression);
          if (cancelled) return;
          setWatchValues((current) => ({
            ...current,
            [expression]: {
              value: {
                name: expression,
                value: result.result,
                type: result.type,
                variablesReference: result.variablesReference,
                evaluateName: expression,
              },
            },
          }));
        } catch (error) {
          if (!cancelled)
            setWatchValues((current) => ({
              ...current,
              [expression]: { error: errorText(error) },
            }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [watches.join("\u0000")]);

  const rows = useMemo(() => {
    const result: Node[] = [];
    const append = (parent: string, depth: number) => {
      for (const variable of loaded[parent]?.items || []) {
        if (result.length >= 2000) return;
        const path = `${parent}/${variable.name}`;
        const matches =
          !filter ||
          `${variable.name} ${variable.value} ${variable.type || ""}`
            .toLowerCase()
            .includes(filter.toLowerCase());
        if (matches) result.push({ path, variable, depth });
        if (expanded.has(path) && depth < 8) append(path, depth + 1);
      }
    };
    for (const scope of scopes) {
      result.push({
        path: scope.name,
        variable: {
          name: scope.name,
          value: scope.expensive ? "load on demand" : "",
          variablesReference: scope.variablesReference,
        },
        depth: 0,
        scope: true,
      });
      if (expanded.has(scope.name)) append(scope.name, 1);
    }
    return result;
  }, [scopes, loaded, expanded, filter]);
  function toggle(node: Node) {
    const opening = !expanded.has(node.path);
    const next = new Set(expanded);
    if (opening) next.add(node.path);
    else next.delete(node.path);
    if (!opening) {
      const below = (path: string) => path === node.path || path.startsWith(node.path + "/");
      for (const path of inFlight.current.keys()) if (below(path)) inFlight.current.delete(path);
      setLoading((current) => new Set([...current].filter((path) => !below(path))));
      updateLoaded((current) =>
        Object.fromEntries(Object.entries(current).filter(([path]) => !below(path))),
      );
    }
    setExpanded(next);
    onExpansion(next);
    if (opening && !loaded[node.path])
      void load(
        node.path,
        node.variable.variablesReference,
        false,
        (node.variable.indexedVariables || 0) > 0,
      );
  }
  const start = Math.max(0, Math.floor(scrollTop / 28) - 6);
  const visible = rows.slice(start, start + Math.ceil(height / 28) + 12);
  const pendingPages = Object.entries(loaded).filter(
    ([path, page]) => expanded.has(path) && (page.more || page.error),
  );
  return (
    <aside className="inspector" aria-label="State inspector">
      <section className="watch-section">
        <div className="panel-heading">
          <h2>Watches</h2>
          <span className="text-xs text-muted-foreground">{watches.length}/32</span>
        </div>
        <form
          className="flex gap-2 px-3 pb-3"
          onSubmit={(event) => {
            event.preventDefault();
            const text = watchInput.trim();
            if (text && watches.length < 32 && !watches.includes(text)) {
              onWatches([...watches, text]);
              setWatchInput("");
            }
          }}
        >
          <Input
            aria-label="Watch expression"
            className="h-8"
            value={watchInput}
            onChange={(e) => setWatchInput(e.target.value)}
            placeholder="Add expression"
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon-sm"
            aria-label="Add watch"
            disabled={!watchInput.trim() || watches.length >= 32}
          >
            <Plus aria-hidden="true" />
          </Button>
        </form>
        <div className="max-h-40 overflow-auto">
          {watches.map((expression) => (
            <div key={expression} className="watch-row">
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  const value = watchValues[expression]?.value;
                  if (value) setDetail(value);
                }}
                title={expression}
              >
                <span className="block truncate text-xs">{expression}</span>
                <span
                  className={`block truncate text-xs ${watchValues[expression]?.error ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {watchValues[expression]?.error ||
                    watchValues[expression]?.value?.value ||
                    "Evaluating…"}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove watch ${expression}`}
                onClick={() => onWatches(watches.filter((item) => item !== expression))}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      </section>
      <div className="panel-heading">
        <h2>Variables</h2>
        <span className="text-xs text-muted-foreground">{frame.name}</span>
      </div>
      <div className="px-3 pb-3">
        <Input
          aria-label="Filter loaded variables"
          className="h-8"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setScrollTop(0);
            viewport.current?.scrollTo(0, 0);
          }}
          placeholder="Filter loaded values"
        />
      </div>
      <div
        ref={viewport}
        className="variable-viewport"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        role="region"
        aria-label="Variables, loaded entries"
        tabIndex={0}
      >
        <div style={{ height: rows.length * 28, position: "relative" }}>
          {visible.map((node, index) => {
            const canExpand = node.variable.variablesReference > 0 && node.depth < 8;
            const changed = !node.scope && observed.observe(node.path, node.variable);
            return (
              <div
                key={node.path}
                className={`variable-row ${node.scope ? "variable-scope" : ""}`}
                style={{
                  position: "absolute",
                  top: (start + index) * 28,
                  paddingLeft: 8 + node.depth * 12,
                }}
              >
                <button
                  className="tree-toggle"
                  aria-label={`${expanded.has(node.path) ? "Collapse" : "Expand"} ${node.variable.name}`}
                  aria-expanded={canExpand ? expanded.has(node.path) : undefined}
                  disabled={!canExpand}
                  onClick={() => toggle(node)}
                >
                  {canExpand ? (
                    expanded.has(node.path) ? (
                      <CaretDown aria-hidden="true" />
                    ) : (
                      <CaretRight aria-hidden="true" />
                    )
                  ) : (
                    <span />
                  )}
                </button>
                <button
                  className="variable-value"
                  title={`${node.variable.name}: ${node.variable.value}${changed ? " (changed since the previous inspected pause)" : ""}`}
                  onClick={() => (node.scope ? toggle(node) : setDetail(node.variable))}
                >
                  <span className="variable-name">{node.variable.name}</span>
                  <span className={changed ? "value-changed" : "text-muted-foreground"}>
                    {loading.has(node.path) ? "Loading…" : node.variable.value}
                  </span>
                  {changed && (
                    <span className="sr-only">Changed since previous inspected pause</span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {pendingPages.length > 0 && (
        <div className="variable-pages">
          {pendingPages.map(([path, page]) => (
            <div key={path}>
              {page.error ? (
                <div>
                  <p className="text-xs text-warning">
                    {path}: {page.error}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={loading.has(path)}
                    onClick={() => void load(path, page.reference, false, page.indexed)}
                  >
                    Retry {path.split("/").at(-1)}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={loading.has(path) || rows.length >= 2000}
                  onClick={() => {
                    void load(path, page.reference, true, page.indexed);
                  }}
                >
                  Load more: {path.split("/").at(-1)}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) {
            setDetail(null);
            setCopyError("");
          }
        }}
      >
        <DialogContent>
          <DialogTitle className="pr-10 text-base font-semibold break-all">
            {detail?.name}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {detail?.type || "Captured value at the current pause"}
          </DialogDescription>
          <pre className="value-detail">{detail?.value}</pre>
          {detail?.evaluateName && (
            <Button
              variant="outline"
              disabled={watches.includes(detail.evaluateName) || watches.length >= 32}
              onClick={() => {
                if (detail.evaluateName) onWatches([...watches, detail.evaluateName]);
              }}
            >
              <Plus aria-hidden="true" />
              {watches.includes(detail.evaluateName)
                ? "Already pinned in watches"
                : "Pin expression in watches"}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() =>
              void api.copy(detail?.value || "").catch((error) => setCopyError(errorText(error)))
            }
          >
            <Copy aria-hidden="true" />
            Copy captured value
          </Button>
          {copyError && (
            <p role="alert" className="text-xs text-destructive">
              {copyError}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </aside>
  );
}
