import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { EditorState, EditorSelection, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  GutterMarker,
  gutter,
  lineNumbers,
  keymap,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  hoverTooltip,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { go } from "@codemirror/lang-go";
import {
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  syntaxTree,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Breakpoint, SourceFile, Evaluation } from "../lib/types";
import { hoverExpression } from "../lib/inspection";

interface Markers {
  line: number;
  points: number[];
}
const setMarkers = StateEffect.define<Markers>();
const markers = StateField.define<Markers>({
  create: () => ({ line: 0, points: [] }),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMarkers)) return effect.value;
    return value;
  },
});
const positionLine = (state: EditorState, line: number) =>
  state.doc.line(Math.max(1, Math.min(line, state.doc.lines))).from;
const highlight = EditorView.decorations.compute([markers], (state) => {
  const line = state.field(markers).line;
  return line > 0 && line <= state.doc.lines
    ? Decoration.set([
        Decoration.line({ class: "execution-line" }).range(positionLine(state, line)),
      ])
    : Decoration.none;
});
class BreakpointMarker extends GutterMarker {
  constructor(readonly placed: boolean) {
    super();
  }
  eq(other: BreakpointMarker) {
    return this.placed === other.placed;
  }
  toDOM() {
    const node = document.createElement("span");
    node.className = this.placed ? "breakpoint-dot" : "breakpoint-empty";
    node.textContent = this.placed ? "●" : "";
    node.setAttribute("aria-hidden", "true");
    return node;
  }
}
const syntax = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: "var(--link)" },
  { tag: [tags.string, tags.character], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
  { tag: [tags.comment, tags.meta], color: "var(--muted-foreground)" },
  { tag: [tags.function(tags.variableName), tags.typeName], fontWeight: "500" },
]);

export interface SourceViewHandle {
  jump: (line: number) => void;
}
interface SourceViewProps {
  source: SourceFile;
  line: number;
  breakpoints: Breakpoint[];
  onToggle: (line: number) => void;
  onCursor: (line: number) => void;
  active: boolean;
  hoverKey?: string;
  onHover?: (expression: string) => Promise<Evaluation>;
}
export const SourceView = forwardRef<SourceViewHandle, SourceViewProps>(function SourceView(
  { source, line, breakpoints, onToggle, onCursor, active, hoverKey, onHover },
  handle,
) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const callbacks = useRef({ onToggle, onCursor, onHover, hoverKey });
  callbacks.current = { onToggle, onCursor, onHover, hoverKey };
  useImperativeHandle(
    handle,
    () => ({
      jump(line) {
        const view = editor.current;
        if (!view) return;
        const position = positionLine(view.state, line);
        view.dispatch({
          selection: EditorSelection.cursor(position),
          effects: EditorView.scrollIntoView(position, { y: "center" }),
        });
        view.focus();
      },
    }),
    [],
  );
  const pointKey = breakpoints.map((point) => point.line).join(",");
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: source.content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.contentAttributes.of({
            "aria-label": "Source code, read only",
            "aria-readonly": "true",
          }),
          markers,
          highlight,
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          highlightSpecialChars(),
          bracketMatching(),
          highlightSelectionMatches(),
          go(),
          syntaxHighlighting(syntax),
          keymap.of([...searchKeymap, ...defaultKeymap]),
          hoverTooltip(async (view, pos) => {
            const callback = callbacks.current.onHover,
              key = callbacks.current.hoverKey;
            if (!callback) return null;
            const node = syntaxTree(view.state).resolveInner(pos, -1);
            if (!/Identifier|VariableName|PropertyName|FieldName/.test(node.name)) return null;
            const row = view.state.doc.lineAt(pos),
              expression = hoverExpression(row.text, pos - row.from);
            if (!expression) return null;
            try {
              const result = await callback(expression.text);
              if (callbacks.current.hoverKey !== key) return null;
              return {
                pos: row.from + expression.from,
                end: row.from + expression.to,
                above: true,
                create() {
                  const dom = document.createElement("div");
                  dom.className = "hover-value";
                  const title = document.createElement("strong");
                  title.textContent = expression.text;
                  const value = document.createElement("pre");
                  value.textContent =
                    result.result.slice(0, 4096) +
                    (result.result.length > 4096 ? " [truncated]" : "");
                  dom.append(title, value);
                  return { dom };
                },
              };
            } catch {
              return null;
            }
          }),
          gutter({
            class: "breakpoint-gutter",
            initialSpacer: () => new BreakpointMarker(false),
            lineMarker: (view, line) =>
              new BreakpointMarker(
                view.state.field(markers).points.includes(view.state.doc.lineAt(line.from).number),
              ),
            lineMarkerChange: (update) =>
              update.state.field(markers) !== update.startState.field(markers),
            domEventHandlers: {
              mousedown: (view, line, event) => {
                event.preventDefault();
                callbacks.current.onToggle(view.state.doc.lineAt(line.from).number);
                return true;
              },
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet)
              callbacks.current.onCursor(
                update.state.doc.lineAt(update.state.selection.main.head).number,
              );
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              fontSize: "14px",
              backgroundColor: "var(--background)",
              color: "var(--foreground)",
            },
            ".cm-scroller": {
              fontFamily: '"Geist Mono Variable", monospace',
              lineHeight: "24px",
              overflow: "auto",
            },
            ".cm-content": { padding: "16px 0" },
            ".cm-line": { padding: "0 16px" },
            ".cm-gutters": {
              backgroundColor: "var(--card)",
              color: "var(--muted-foreground)",
              borderRight: "1px solid var(--border)",
            },
            ".cm-lineNumbers .cm-gutterElement": { minWidth: "40px", padding: "0 8px" },
            ".cm-activeLine": { backgroundColor: "var(--muted)" },
            ".cm-activeLineGutter": { backgroundColor: "var(--muted)" },
            ".cm-cursor": { borderLeftColor: "var(--foreground)" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
              backgroundColor: "var(--accent)",
            },
            ".cm-panels": { backgroundColor: "var(--popover)", color: "var(--foreground)" },
            ".cm-searchMatch": {
              backgroundColor: "var(--accent)",
              outline: "1px solid var(--link)",
            },
          }),
        ],
      }),
    });
    view.scrollDOM.tabIndex = 0;
    view.scrollDOM.setAttribute("role", "region");
    view.scrollDOM.setAttribute("aria-label", "Scrollable source code");
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [source.path]);
  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    const effects: StateEffect<unknown>[] = [
      setMarkers.of({ line, points: pointKey ? pointKey.split(",").map(Number) : [] }),
    ];
    if (line > 0) {
      const doc = EditorState.create({ doc: source.content });
      effects.push(EditorView.scrollIntoView(positionLine(doc, line), { y: "center" }));
    }
    view.dispatch({
      changes:
        source.content !== view.state.doc.toString()
          ? { from: 0, to: view.state.doc.length, insert: source.content }
          : undefined,
      effects,
    });
  }, [source.content, line, pointKey]);
  useEffect(() => {
    if (active) editor.current?.requestMeasure();
  }, [active]);
  return <div ref={host} className="source-view" />;
});
