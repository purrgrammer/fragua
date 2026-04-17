import type { Config } from "tailwindcss";

// Minimal Tailwind baseline. We explicitly list content globs instead of
// relying on Tailwind's defaults so adding a new folder (e.g. tests with
// inline markup) makes the miss obvious rather than silently shipping
// unused styles.
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
