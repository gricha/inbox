import { registerCustomTheme, resolveTheme, type DiffsTheme } from "@pierre/diffs";

// Copies of a few syntax themes, each colour swapped where it doesn't read on the theme's sheet or changed lines; every other
// colour, and so each theme's look, stays its own. src/themes.ts's `diff` names them.
// - Shiki's Solarized Light and Catppuccin Latte draw much of the code at 2:1 to 3:1 on the sheet, less on a changed line's
//   tint: darkened (4.4:1 and up on the sheet, comments a step under). Latte's maroon parameters take its text colour: a red
//   name on an added line reads as a removal.
// - Pierre's light, Light's and Sand's, draws constants, variables, numbers, operators and strings in oranges, yellows, cyans
//   and greens at 2:1 to 3.5:1 on the sheet, less inside a changed word's box: darkened (4.5:1 and up on the sheet, 3.5:1 in a
//   box), comments a step under.
// - Pierre's dark, Dark's and Slate's, draws punctuation and operators in a grey at 2.4:1 to 2.8:1 on the sheet and 1.2:1 in a
//   changed word's box, and comments, functions and types not far above: lighter, punctuation in Dark's pencil and comments
//   in Slate's.
// - Sentry Dusk's is Pierre's dark in the Sentry syntax colours of gricha/sentry-codex-theme (text, punctuation, functions,
//   strings), its keywords a lighter Blurple to read on the sheet, and the rest from Sentry's site palette.
// - Shiki's GitHub Light Default, Sentry Dawn's as in that theme, draws a stray carriage return and ignored files' names in
//   near-white: its text colour.
// - Shiki's Gruvbox draws broken code in its dark red at 2.9:1: its bright red.
// - Shiki's Tokyo Night draws comments, doc comments and markdown punctuation at 2.4:1 to 3.5:1: lighter, comments in folke's
//   dark5 (4.1:1 on the sheet, about 3:1 on a changed line).
const COPIES: Record<string, { of: string; colours: Record<string, string> }> = {
  "pierre-light-desk": {
    of: "pierre-light",
    colours: {
      "#d5901c": "#8f5c00", // constants
      "#d47628": "#9c4c15", // variables
      "#d5a910": "#7d6300", // constants' yellow
      "#1ca1c7": "#0d6d89", // numbers, booleans
      "#08c0ef": "#0a7187", // operators
      "#199f43": "#11702f", // strings
      "#18a46c": "#0f7062", // attributes
      "#16a994": "#0f7062", // escapes
      "#17a5af": "#0f7480", // regular expressions
      "#d5512f": "#a83a1c",
      "#1a85d4": "#1864a6", // decorators
      "#d32a61": "#c02556", // keywords
      "#737373": "#6b6b6b", // comments
    },
  },
  "pierre-dark-desk": {
    of: "pierre-dark",
    colours: {
      "#636363": "#a7b0be", // punctuation and operators
      "#737373": "#8e98a5", // comments
      "#9d6afb": "#b391fc", // functions
      "#d568ea": "#de88ef", // types
    },
  },
  "solarized-light-desk": {
    of: "solarized-light",
    colours: {
      "#657b83": "#4a6068", // base00, the code itself
      "#93a1a1": "#7b8a8a", // base1, comments
      "#859900": "#5c6c00",
      "#2aa198": "#17766f",
      "#268bd2": "#1b679e",
      "#b58900": "#7f6100",
      "#cb4b16": "#a8400f",
      "#dc322f": "#b52a27",
      "#6c71c4": "#5458a8",
      "#d33682": "#a82a68",
    },
  },
  "catppuccin-latte-desk": {
    of: "catppuccin-latte",
    colours: {
      "#df8e1d": "#9a5f0a", // yellow, types
      "#fe640b": "#b84a08", // peach, constants
      "#04a5e5": "#0b6f9c", // sky, operators
      "#179299": "#0f6f75", // teal
      "#40a02b": "#2c751c", // green, strings
      "#1e66f5": "#1a56d6", // blue, functions
      "#ea76cb": "#a83f8c", // pink
      "#dd7878": "#a34a4a", // flamingo
      "#dc8a78": "#9c5a46", // rosewater
      "#7287fd": "#4f5fd6", // lavender
      "#209fb5": "#13708a", // sapphire
      "#e64553": "#4c4f69", // maroon, parameters: text
    },
  },
  "sentry-dusk-desk": {
    of: "pierre-dark",
    colours: {
      "#fafafa": "#e6dff9", // text
      "#ffa359": "#e6dff9", // variables: text, as the theme draws them
      "#636363": "#c8bedf", // punctuation and operators
      "#08c0ef": "#c8bedf", // logical and arithmetic operators
      "#737373": "#9a93ad", // comments
      "#ff678d": "#9585fb", // keywords: Blurple, lighter
      "#9d6afb": "#a58cff", // functions
      "#5ecc71": "#8ee6d7", // strings
      "#64d1db": "#8ee6d7", // regular expressions
      "#d568ea": "#e2abe0", // types: v-lt-purple
      "#a3a3a3": "#cfcfdb", // parameters: gray-3
      "#68cdf2": "#fa7faa", // numbers, booleans: lt-pink
      "#69b1ff": "#fa7faa", // decorators
      "#ff855e": "#f4834f", // md-orange
      "#ffab16": "#ffb287", // namespaces, constants: lt-orange
      "#ffd452": "#ffdb4a", // constants: lt-yellow
      "#60d199": "#7db6a0", // attributes: the theme's green
      "#61d5c0": "#7db6a0", // escapes
    },
  },
  "github-light-default-desk": {
    of: "github-light-default",
    colours: { "#f6f8fa": "#1f2328", "#eaeef2": "#1f2328" },
  },
  "gruvbox-dark-medium-desk": {
    of: "gruvbox-dark-medium",
    colours: { "#cc241d": "#fb4934" }, // invalid code
  },
  "tokyo-night-desk": {
    of: "tokyo-night",
    colours: {
      "#51597d": "#737aa2", // comments: folke's dark5
      "#4e5579": "#6b74a6", // markdown's raw and quote punctuation
      "#5a638c": "#7a82b0", // jsdoc
      "#646e9c": "#7f88b5", // doc comments' types
      "#914c54": "#bb616b", // markup.deleted
    },
  },
};

for (const [name, { of, colours }] of Object.entries(COPIES))
  registerCustomTheme(
    name,
    async () => {
      // An 8-digit colour keeps its alpha: only its first six digits match.
      const json = JSON.stringify(await resolveTheme(of)).replaceAll(/#[0-9a-f]{6}/gi, (hex) => colours[hex.toLowerCase()] ?? hex);
      const theme = JSON.parse(json) as DiffsTheme;
      return { ...theme, name, ...(theme.textmate && { textmate: { ...theme.textmate, name } }) };
    },
    "diffs",
  );
