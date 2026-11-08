import { registerCustomTheme, resolveTheme, type DiffsTheme } from "@pierre/diffs";

// Copies of a few syntax themes, each colour swapped where it doesn't read on the theme's sheet or changed lines; every other
// colour, and so each theme's look, stays its own. src/themes.ts's `diff` names them.
// - Shiki's Solarized Light and Catppuccin Latte draw much of the code at 2:1 to 3:1 on the sheet, less on a changed line's
//   tint: darkened (4.4:1 and up on the sheet, comments a step under). Latte's maroon parameters take its text colour: a red
//   name on an added line reads as a removal.
// - Pierre's soft dark, Sentry's, draws punctuation, parameters and comments in neutral greys that vanish on its changed lines
//   and the changed words' boxes: lighter, in Sentry's lavender.
// - Shiki's Tokyo Night draws comments, doc comments and markdown punctuation at 2.4:1 to 3.5:1: lighter, comments in folke's
//   dark5 (4.1:1 on the sheet, about 3:1 on a changed line).
const COPIES: Record<string, { of: string; colours: Record<string, string> }> = {
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
  "pierre-dark-soft-desk": {
    of: "pierre-dark-soft",
    colours: {
      "#737373": "#9a92ad", // punctuation and operators
      "#8a8a8a": "#a8a1bb", // parameters
      "#636363": "#857d99", // comments
    },
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
