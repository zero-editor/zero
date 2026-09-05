import { EditorView, ViewPlugin, tooltips } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { constNames } from "./constNames";
import { undefinedNames } from "./undefinedName";
import { EditorTheme, getSettings, onSettingsChange, resolvedAppearance } from "./settings";

/**
 * `undefined` has no highlight tag to hang a colour on — see undefinedName.ts
 * — so it arrives as a decoration class, and each theme paints it whatever it
 * already paints `null`. The `*` rule is for the highlighting span nested
 * inside the decoration's, which would otherwise keep its own colour.
 */
const undefinedColor = (color: string) =>
  EditorView.theme({ ".cm-undefined": { color }, ".cm-undefined *": { color } });

// VS Code / Cursor "Dark Modern" (Dark+) — editor chrome
const darkModernChrome = EditorView.theme(
  {
    "&": {
      backgroundColor: "#1f1f1f",
      color: "#cccccc",
    },
    ".cm-content": {
      caretColor: "#aeafad",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#aeafad",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection": {
      backgroundColor: "#264f78",
    },
    ".cm-selectionBackground": {
      backgroundColor: "#264f7855",
    },
    ".cm-activeLine": {
      backgroundColor: "#ffffff08",
    },
    ".cm-gutters": {
      backgroundColor: "#1f1f1f",
      color: "#6e7681",
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "#cccccc",
    },
    // room for three digits from the first line, so the gutter doesn't widen
    // and shove the text over at line 10 (or 100). Border-box, and CodeMirror
    // pads it 5px + 3px, hence the 8px — 3.2ch used to be a hair short
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "calc(3ch + 8px)",
    },
    ".cm-matchingBracket": {
      backgroundColor: "#0064961a",
      outline: "1px solid #888888aa",
    },
    ".cm-searchMatch": {
      backgroundColor: "#613214",
      outline: "1px solid #74572f",
    },
    ".cm-selectionMatch": {
      backgroundColor: "#343a41",
    },
  },
  { dark: true }
);

// Dark+ token colors
const darkModernHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.bool, t.null, t.atom, t.self], color: "#569cd6" },
  {
    tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
    color: "#c586c0",
  },
  { tag: [t.string, t.special(t.string), t.character], color: "#ce9178" },
  { tag: [t.number, t.integer, t.float], color: "#b5cea8" },
  { tag: [t.comment, t.blockComment, t.lineComment], color: "#6a9955" },
  // `t.function(t.definition(...))` is what a *declaration* gets — without it
  // the name in `export function useThing()` falls back to the plain-variable
  // rule below and comes out light blue instead of yellow
  {
    tag: [
      t.function(t.variableName),
      t.function(t.definition(t.variableName)),
      t.function(t.propertyName),
      t.macroName,
    ],
    color: "#dcdcaa",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "#4ec9b0" },
  { tag: [t.variableName, t.propertyName, t.definition(t.variableName), t.attributeName], color: "#9cdcfe" },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: "#4fc1ff" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#d4d4d4" },
  { tag: [t.regexp], color: "#d16969" },
  { tag: [t.escape, t.special(t.character)], color: "#d7ba7d" },
  // JSX splits two ways: lowercase `<div>` is a built-in and stays blue, while
  // `<Table>` is a component and takes the type colour, as it does in Cursor
  { tag: [t.standard(t.tagName)], color: "#569cd6" },
  { tag: [t.tagName], color: "#4ec9b0" },
  { tag: [t.angleBracket], color: "#808080" },
  { tag: [t.heading], color: "#569cd6", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#3794ff" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.meta, t.processingInstruction], color: "#808080" },
  { tag: [t.invalid], color: "#f44747" },
]);

export const darkModern = [
  darkModernChrome,
  syntaxHighlighting(darkModernHighlight),
  undefinedColor("#569cd6"),
  undefinedNames,
  constNames,
];

// VS Code / Cursor "Light Modern" (Light+) — the same port, in daylight
const lightModernChrome = EditorView.theme(
  {
    "&": {
      backgroundColor: "#ffffff",
      color: "#3b3b3b",
    },
    ".cm-content": {
      caretColor: "#000000",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#000000",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection": {
      backgroundColor: "#add6ff",
    },
    ".cm-selectionBackground": {
      backgroundColor: "#add6ff80",
    },
    ".cm-activeLine": {
      backgroundColor: "#00000008",
    },
    ".cm-gutters": {
      backgroundColor: "#ffffff",
      color: "#237893",
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "#0b216f",
    },
    // room for three digits from the first line, so the gutter doesn't widen
    // and shove the text over at line 10 (or 100). Border-box, and CodeMirror
    // pads it 5px + 3px, hence the 8px — 3.2ch used to be a hair short
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "calc(3ch + 8px)",
    },
    ".cm-matchingBracket": {
      backgroundColor: "#0064001a",
      outline: "1px solid #b9b9b9",
    },
    ".cm-searchMatch": {
      backgroundColor: "#ea5c0055",
      outline: "1px solid #b89500",
    },
    ".cm-selectionMatch": {
      backgroundColor: "#e8e8e8",
    },
  },
  { dark: false }
);

// Light+ token colors
const lightModernHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.bool, t.null, t.atom, t.self], color: "#0000ff" },
  {
    tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
    color: "#af00db",
  },
  { tag: [t.string, t.special(t.string), t.character], color: "#a31515" },
  { tag: [t.number, t.integer, t.float], color: "#098658" },
  { tag: [t.comment, t.blockComment, t.lineComment], color: "#008000" },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.definition(t.variableName)),
      t.function(t.propertyName),
      t.macroName,
    ],
    color: "#795e26",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "#267f99" },
  { tag: [t.variableName, t.propertyName, t.definition(t.variableName), t.attributeName], color: "#001080" },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: "#0070c1" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#3b3b3b" },
  { tag: [t.regexp], color: "#811f3f" },
  { tag: [t.escape, t.special(t.character)], color: "#ee0000" },
  { tag: [t.standard(t.tagName)], color: "#800000" },
  { tag: [t.tagName], color: "#267f99" },
  { tag: [t.angleBracket], color: "#800000" },
  { tag: [t.heading], color: "#0000ff", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#006ab1" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.meta, t.processingInstruction], color: "#808080" },
  { tag: [t.invalid], color: "#cd3131" },
]);

export const lightModern = [
  lightModernChrome,
  syntaxHighlighting(lightModernHighlight),
  undefinedColor("#0000ff"),
  undefinedNames,
  constNames,
];

// TRMNL — the theme from trmnl.com's JSON editor, dark variant. Ported as
// written except for the font: the source pins Space Mono at 0.75rem, but
// zero's editor font is set once in styles/main-column.css for every theme,
// and Space Mono isn't in the bundle anyway. constNames stays out too — its
// colours live in styles/main-column.css and are Dark Modern's.
const trmnlChrome = EditorView.theme(
  {
    "&": {
      color: "#d8dee9",
      backgroundColor: "#151515",
    },
    ".cm-content": {
      caretColor: "#d8dee9",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#d8dee9",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(131,214,197,0.15)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255,255,255,0.04)",
    },
    ".cm-gutters": {
      backgroundColor: "#151515",
      color: "#6d6d6d",
      borderRight: "1px solid #2a2a2a",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(255,255,255,0.06)",
    },
    // room for three digits from the first line, so the gutter doesn't widen
    // and shove the text over at line 10 (or 100). Border-box, and CodeMirror
    // pads it 5px + 3px, hence the 8px — 3.2ch used to be a hair short
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "calc(3ch + 8px)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "#2a2a2a",
      color: "#6d6d6d",
      border: "none",
    },
    ".cm-tooltip": {
      backgroundColor: "#151515",
      border: "1px solid #2a2a2a",
      color: "#d8dee9",
    },
    ".cm-tooltip .cm-tooltip-arrow::before": {
      borderTopColor: "#2a2a2a",
      borderBottomColor: "#2a2a2a",
    },
    ".cm-tooltip .cm-tooltip-arrow::after": {
      borderTopColor: "#151515",
      borderBottomColor: "#151515",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        backgroundColor: "rgba(131,214,197,0.15)",
        color: "#d8dee9",
      },
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(131,214,197,0.2)",
      outline: "1px solid rgba(131,214,197,0.4)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(131,214,197,0.35)",
    },
    ".cm-panels": {
      backgroundColor: "#151515",
      color: "#d8dee9",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid #2a2a2a",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid #2a2a2a",
    },
  },
  { dark: true }
);

const trmnlHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6d6d6d", fontStyle: "italic" },
  {
    tag: [t.punctuation, t.bracket, t.squareBracket, t.paren, t.brace, t.angleBracket],
    color: "#a4a4a4",
  },
  { tag: t.tagName, color: "#699b87" },
  { tag: t.attributeName, color: "#aaa0fa", fontStyle: "italic" },
  { tag: [t.string, t.special(t.string)], color: "#e394dc" },
  { tag: [t.number, t.integer, t.float], color: "#ebc88d" },
  {
    tag: [t.keyword, t.operatorKeyword, t.moduleKeyword, t.controlKeyword],
    color: "#83d6c5",
  },
  { tag: t.function(t.variableName), color: "#efb080" },
  { tag: [t.propertyName, t.special(t.propertyName)], color: "#81d2ce" },
  { tag: [t.className, t.typeName, t.namespace], color: "#87c3ff" },
  { tag: t.operator, color: "#83d6c5" },
  { tag: [t.bool, t.literal, t.null, t.atom], color: "rgba(255,255,255,0.36)" },
  { tag: [t.variableName, t.regexp], color: "#e394dc" },
  { tag: t.definition(t.variableName), color: "#d8dee9" },
  { tag: t.self, color: "#83d6c5" },
  { tag: t.inserted, color: "#a3be8c" },
  { tag: t.deleted, color: "#bf616a" },
  { tag: t.changed, color: "#efb080" },
  { tag: t.invalid, color: "#bf616a" },
  { tag: t.heading, color: "#699b87", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#83d6c5", textDecoration: "underline" },
  { tag: t.url, color: "#83d6c5" },
  { tag: t.processingInstruction, color: "#6d6d6d" },
  { tag: t.attributeValue, color: "#e394dc" },
  { tag: t.meta, color: "#6d6d6d" },
]);

export const trmnl = [
  trmnlChrome,
  syntaxHighlighting(trmnlHighlight),
  undefinedColor("rgba(255,255,255,0.36)"),
  undefinedNames,
];

// TRMNL, light variant — same source file as the dark one (trmnl.com's JSON
// editor, codemirror_trmnl_theme.js), ported under the same rules: the font
// pinning stays out, the colors come through as written.
const trmnlLightChrome = EditorView.theme(
  {
    "&": {
      color: "#2b2b2b",
      backgroundColor: "#f2f0ed",
    },
    ".cm-content": {
      caretColor: "#2b2b2b",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#2b2b2b",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(13,122,107,0.15)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(0,0,0,0.04)",
    },
    ".cm-gutters": {
      backgroundColor: "#f2f0ed",
      color: "#6b7280",
      borderRight: "1px solid #e5e2dd",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(0,0,0,0.06)",
    },
    // room for three digits from the first line, so the gutter doesn't widen
    // and shove the text over at line 10 (or 100). Border-box, and CodeMirror
    // pads it 5px + 3px, hence the 8px — 3.2ch used to be a hair short
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "calc(3ch + 8px)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "#e5e2dd",
      color: "#6b7280",
      border: "none",
    },
    ".cm-tooltip": {
      backgroundColor: "#f2f0ed",
      border: "1px solid #e5e2dd",
      color: "#2b2b2b",
    },
    ".cm-tooltip .cm-tooltip-arrow::before": {
      borderTopColor: "#e5e2dd",
      borderBottomColor: "#e5e2dd",
    },
    ".cm-tooltip .cm-tooltip-arrow::after": {
      borderTopColor: "#f2f0ed",
      borderBottomColor: "#f2f0ed",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        backgroundColor: "rgba(13,122,107,0.12)",
        color: "#2b2b2b",
      },
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(13,122,107,0.2)",
      outline: "1px solid rgba(13,122,107,0.4)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(13,122,107,0.35)",
    },
    ".cm-panels": {
      backgroundColor: "#f2f0ed",
      color: "#2b2b2b",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid #e5e2dd",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid #e5e2dd",
    },
  },
  { dark: false }
);

const trmnlLightHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6b7280", fontStyle: "italic" },
  {
    tag: [t.punctuation, t.bracket, t.squareBracket, t.paren, t.brace, t.angleBracket],
    color: "#525252",
  },
  { tag: t.tagName, color: "#2d5243" },
  { tag: t.attributeName, color: "#5b4dbf", fontStyle: "italic" },
  { tag: [t.string, t.special(t.string)], color: "#a03d8f" },
  { tag: [t.number, t.integer, t.float], color: "#9a5a1a" },
  {
    tag: [t.keyword, t.operatorKeyword, t.moduleKeyword, t.controlKeyword],
    color: "#0d7a6b",
  },
  { tag: t.function(t.variableName), color: "#9a5a1a" },
  { tag: [t.propertyName, t.special(t.propertyName)], color: "#0d7a6b" },
  { tag: [t.className, t.typeName, t.namespace], color: "#1d4ed8" },
  { tag: t.operator, color: "#0d7a6b" },
  { tag: [t.bool, t.literal, t.null, t.atom], color: "#4b5563" },
  { tag: [t.variableName, t.regexp], color: "#a03d8f" },
  { tag: t.definition(t.variableName), color: "#2b2b2b" },
  { tag: t.self, color: "#0d7a6b" },
  { tag: t.inserted, color: "#15803d" },
  { tag: t.deleted, color: "#991b1b" },
  { tag: t.changed, color: "#9a5a1a" },
  { tag: t.invalid, color: "#991b1b" },
  { tag: t.heading, color: "#2d5243", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#0d7a6b", textDecoration: "underline" },
  { tag: t.url, color: "#0d7a6b" },
  { tag: t.processingInstruction, color: "#6b7280" },
  { tag: t.attributeValue, color: "#a03d8f" },
  { tag: t.meta, color: "#6b7280" },
]);

export const trmnlLight = [
  trmnlLightChrome,
  syntaxHighlighting(trmnlLightHighlight),
  undefinedColor("#4b5563"),
  undefinedNames,
];

/** What the settings panel lists: label plus the token colours it shows as a
 *  swatch strip — keyword, string, function, type, number, in that order. */
export const EDITOR_THEME_CHOICES: { id: EditorTheme; label: string; swatch: string[] }[] = [
  {
    id: "dark-modern",
    label: "Dark Modern",
    swatch: ["#569cd6", "#ce9178", "#dcdcaa", "#4ec9b0", "#b5cea8"],
  },
  {
    id: "trmnl",
    label: "TRMNL",
    swatch: ["#83d6c5", "#e394dc", "#efb080", "#87c3ff", "#ebc88d"],
  },
];

function themeFor(id: EditorTheme): Extension {
  const light = resolvedAppearance() === "light";
  if (id === "trmnl") return light ? trmnlLight : trmnl;
  return light ? lightModern : darkModern;
}

/**
 * The theme every editor should use: whatever settings say right now, and it
 * follows along live when the settings panel changes it. One call per
 * EditorView — the compartment addresses that view's state, and the plugin
 * needs the view to dispatch the reconfigure into.
 */
export function editorTheme(): Extension {
  const compartment = new Compartment();
  const follow = ViewPlugin.define((view) => {
    const unsub = onSettingsChange(() => {
      view.dispatch({ effects: compartment.reconfigure(themeFor(getSettings().editorTheme)) });
    });
    return { destroy: unsub };
  });
  // Completions and hovers hang off <body>, not off the editor.
  //
  // CodeMirror positions them `fixed`, which normally escapes any clipping
  // above it — but .workspace carries a transform, and a transform makes its
  // element the containing block for fixed descendants, which puts them back
  // under the overflow rules of everything in between. The editor is a card
  // with rounded corners now, so it clips to them, and a completion list
  // opened on the last visible line is exactly the thing that reaches past
  // the bottom edge. Parented to <body> the tooltip has no transformed
  // ancestor at all, so it is measured against the window and nothing clips
  // it. Nothing styles .cm-tooltip from here either — CodeMirror injects its
  // own styles document-wide, so they follow it out.
  return [
    compartment.of(themeFor(getSettings().editorTheme)),
    follow,
    tooltips({ parent: document.body }),
  ];
}
