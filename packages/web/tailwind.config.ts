// Tailwind config for the swarm web UI.
//
// Colour model:
//   Tokens are defined as `oklch(...)` values in `src/styles/globals.css`
//   (the shadcn "radix-nova" preset the AI Elements CLI bootstraps).
//   Instead of wrapping them in `hsl(var(--x))` the classes consume the
//   variables directly — same pattern Tailwind v4 uses, works fine under
//   v3, and keeps the vendored shadcn components rendering correctly.
//
// Typography:
//   `font-sans` points at Geist Variable (loaded from @fontsource-variable
//   in globals.css) because that's the default the `Nova` shadcn preset
//   targets. `font-mono` stays on JetBrains Mono for code/ids/tabular
//   readouts.
//
// Streamdown source:
//   `node_modules/streamdown/dist/*.js` is included in `content` so the
//   Tailwind JIT picks up the utility classes Streamdown emits at runtime
//   (prose typography, code-fence styling, etc.) — without this line the
//   AI Elements `MessageResponse` body would render unstyled. The spec
//   for P5.08 specifies this via a Tailwind v4 `@source` directive in
//   `globals.css`; we keep an equivalent comment there for forward-compat
//   but the actual scan hook on v3 is this `content` entry.

import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const monoStack = [
  "JetBrains Mono",
  "ui-monospace",
  "SFMono-Regular",
  "Menlo",
  "Monaco",
  "Consolas",
  "Liberation Mono",
  "Courier New",
  "monospace",
];

const sansStack = ["Geist Variable", "ui-sans-serif", "system-ui", "sans-serif"];

const config: Config = {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    // Streamdown (via AI Elements' MessageResponse) emits Tailwind classes
    // at runtime; scan its compiled output so those classes survive JIT
    // purging in production builds.
    "../../node_modules/streamdown/dist/*.js",
  ],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: sansStack,
        heading: sansStack,
        mono: monoStack,
      },
      colors: {
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          primary: "var(--sidebar-primary)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [animate],
};

export default config;
