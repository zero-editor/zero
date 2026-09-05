import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import { getSettings, updateSettings } from "./settings";

/**
 * Highlighting comes in two waves.
 *
 * The languages zero is itself written in are bundled and applied the instant
 * the editor exists, because those are the files you open all day and a tab
 * that lands grey and colours in a frame later is a flicker you'd notice.
 * Everything else — the other hundred and thirty-odd — is fetched only when a
 * file of that kind is actually opened, so a project with no Ruby in it never
 * pays for the Ruby mode.
 *
 * A script named without an extension gets a third chance: its shebang line
 * names an interpreter, and the interpreter names the mode.
 */
export function langFor(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "py":
    case "pyi":
      return [python()];
    case "css":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    case "json":
      return [json()];
    case "md":
    case "markdown":
      // fenced code blocks colour as their own language, fetched from the
      // registry only when a fence actually names one
      // GitHub's flavour rather than plain CommonMark: `- [ ]`, tables and
      // ~~strikethrough~~ are then nodes in the tree, which is what lets a
      // note draw its checkboxes — see noteLive.ts
      return [markdown({ base: markdownLanguage, codeLanguages: ALL })];
    case "rs":
      return [rust()];
    default:
      return [];
  }
}

/**
 * Languages the registry doesn't carry, each brought in as its own package and
 * described the same way, so everything downstream — filename matching, fence
 * names in markdown, the language picker — sees one list. Ours sit first: a
 * name that appears in both is a name we had a reason to re-answer.
 */
const EXTRAS: LanguageDescription[] = [
  LanguageDescription.of({
    name: "Svelte",
    extensions: ["svelte"],
    load: () => import("@replit/codemirror-lang-svelte").then((m) => m.svelte()),
  }),
  LanguageDescription.of({
    name: "Elixir",
    extensions: ["ex", "exs"],
    load: () => import("codemirror-lang-elixir").then((m) => m.elixir()),
  }),
  LanguageDescription.of({
    name: "GraphQL",
    alias: ["gql"],
    extensions: ["graphql", "gql"],
    // graphql() is the editor-with-schema kit; the bare language is this one
    load: () => import("cm6-graphql").then((m) => m.graphqlLanguageSupport()),
  }),
  LanguageDescription.of({
    name: "Nix",
    extensions: ["nix"],
    load: () => import("@replit/codemirror-lang-nix").then((m) => m.nix()),
  }),
  LanguageDescription.of({
    name: "Zig",
    extensions: ["zig", "zon"],
    load: () => import("codemirror-lang-zig").then((m) => m.zig()),
  }),
  LanguageDescription.of({
    name: "Terraform",
    alias: ["hcl"],
    extensions: ["tf", "tfvars", "hcl"],
    load: () => import("codemirror-lang-terraform").then((m) => m.terraform()),
  }),
];

/** The whole roster: zero's own additions, then the hundred-and-forty-odd. */
const ALL: readonly LanguageDescription[] = [...EXTRAS, ...languages];

/**
 * Extensions language-data doesn't recognise, mapped to the mode a person
 * would expect. Keys are lowercased extensions, or whole filenames when the
 * name is the whole signal.
 */
const ALIASES: Record<string, string> = {
  zsh: "Shell",
  zshrc: "Shell",
  bashrc: "Shell",
  fish: "Shell",
  ksh: "Shell",
  ".bashrc": "Shell",
  ".zshrc": "Shell",
  ".profile": "Shell",
  ".bash_profile": "Shell",
  ".zprofile": "Shell",
  ".env": "Properties files",
  // .m is Mathematica by language-data's reckoning and Objective-C by
  // everyone else's
  m: "Objective-C",
  mdx: "Markdown",
  mkd: "Markdown",
  jsonc: "JSON",
  json5: "JSON",
  webmanifest: "JSON",
  ".babelrc": "JSON",
  ".eslintrc": "JSON",
  ".prettierrc": "JSON",
  bzl: "Python",
  ".gitmodules": "Properties files",
  // ignore files are comments and patterns, which is most of what the
  // properties mode colours anyway
  ".gitignore": "Properties files",
  ".gitattributes": "Properties files",
  ".dockerignore": "Properties files",
  ".npmignore": "Properties files",
  ".editorconfig": "Properties files",
  ".npmrc": "Properties files",
  ".gitconfig": "Properties files",
  cfg: "Properties files",
  plist: "XML",
  xsd: "XML",
  xslt: "XML",
  storyboard: "XML",
  podspec: "Ruby",
  gemspec: "Ruby",
  brewfile: "Ruby",
  ino: "C++",
  ipp: "C++",
  metal: "C++",
};

/**
 * The user's own row in the tables, set from a tab's context menu and kept in
 * settings: this kind of file is that language, whatever the tables think.
 * "plain" is a real answer — highlighting off — and can't collide with a
 * language, because the sentinel never reaches the registry.
 */
export const PLAIN = "plain";

/** The key a choice is stored under: the extension when the file has one, the
 *  whole lowercased name when the name is all there is (Makefile, .envrc). */
export function overrideKeyFor(fileName: string): string {
  const name = fileName.split("/").pop() ?? fileName;
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(dot + 1) : name).toLowerCase();
}

export function overrideFor(fileName: string): string | null {
  return getSettings().langOverrides[overrideKeyFor(fileName)] ?? null;
}

/** Remember a choice — a language name, PLAIN, or null to return to the
 *  tables — for every file sharing this one's key. */
export function setLanguageOverride(fileName: string, choice: string | null) {
  const key = overrideKeyFor(fileName);
  const next = { ...getSettings().langOverrides };
  if (choice) next[key] = choice;
  else delete next[key];
  updateSettings({ langOverrides: next });
}

/** Every name the picker can offer, alphabetically. */
export function languageNames(): string[] {
  return ALL.map((d) => d.name).sort((a, b) => a.localeCompare(b));
}

/**
 * The mode for a file zero doesn't bundle, or null when `langFor` already
 * covered it and when nothing matches at all. Resolving it means fetching a
 * chunk, so it lands a moment after the text does.
 */
export async function lazyLangFor(path: string): Promise<Extension[] | null> {
  const name = path.split("/").pop() ?? path;

  // the user's word beats every table, including the bundled wave — an empty
  // list is the "plain" answer, and reconfiguring to it turns colouring off
  const chosen = overrideFor(name);
  if (chosen === PLAIN) return [];
  if (chosen) {
    const d = LanguageDescription.matchLanguageName(ALL, chosen);
    // an override naming a mode that no longer exists falls back to the tables
    if (d) return loadMode(d);
  }

  if (langFor(name).length) return null;

  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const alias = ALIASES[name] ?? ALIASES[name.toLowerCase()] ?? ALIASES[ext];
  let desc = alias
    ? LanguageDescription.matchLanguageName(ALL, alias)
    : LanguageDescription.matchFilename(ALL, name);
  // families named by prefix rather than extension: Dockerfile.dev,
  // .env.production
  if (!desc) {
    const lower = name.toLowerCase();
    if (lower.startsWith("dockerfile")) {
      desc = LanguageDescription.matchLanguageName(ALL, "Dockerfile");
    } else if (lower.startsWith(".env.")) {
      desc = LanguageDescription.matchLanguageName(ALL, "Properties files");
    }
  }
  return desc ? loadMode(desc) : null;
}

/**
 * Interpreters a shebang can name, keyed after version numbers are stripped —
 * python3.12 looks up as python.
 */
const INTERPRETERS: Record<string, string> = {
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  dash: "Shell",
  ksh: "Shell",
  fish: "Shell",
  python: "Python",
  node: "JavaScript",
  bun: "JavaScript",
  deno: "JavaScript",
  ruby: "Ruby",
  perl: "Perl",
  php: "PHP",
  lua: "Lua",
};

/**
 * The mode for a script whose first line says what it is — `deploy` opening
 * with `#!/bin/bash`. Only worth consulting when the name said nothing.
 */
export async function lazyLangForShebang(content: string): Promise<Extension[] | null> {
  if (!content.startsWith("#!")) return null;
  const nl = content.indexOf("\n");
  const words = content
    .slice(2, nl === -1 ? undefined : nl)
    .trim()
    .split(/\s+/);
  // `#!/usr/bin/env -S python3 -u` — the interpreter is the first word after
  // env that isn't a flag
  let interp = words[0]?.split("/").pop() ?? "";
  if (interp === "env") interp = words.slice(1).find((w) => !w.startsWith("-")) ?? "";
  interp = (interp.split("/").pop() ?? "").toLowerCase().replace(/[\d.]+$/, "");
  const lang = INTERPRETERS[interp];
  const desc = lang ? LanguageDescription.matchLanguageName(ALL, lang) : null;
  return desc ? loadMode(desc) : null;
}

async function loadMode(desc: LanguageDescription): Promise<Extension[] | null> {
  try {
    return [await desc.load()];
  } catch {
    // a chunk that won't load leaves the file plain, which is what it was
    return null;
  }
}
