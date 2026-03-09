import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const args = process.argv.slice(2);
const prod = args[0] === "production";
const watch = args.includes("--watch");

const context = await esbuild.context({
  banner: {
    js: "/* eslint-disable */"
  },
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js"
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
