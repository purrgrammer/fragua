// Vitest config for @fragua/web.
//
// jsdom environment (not happy-dom): Radix UI primitives — AlertDialog,
// DropdownMenu, Popover — portal + focus-trap their content, which happy-dom
// silently failed to mount, forcing components to be hand-rolled just so tests
// could see them. jsdom renders them with the small DOM shims in
// test/vitest.setup.ts.
//
// Kept separate from vite.config.ts so the dev-proxy / Tailwind machinery
// doesn't run during tests. The `@` → `src` alias mirrors vite.config.ts and
// tsconfig.json#paths.

import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./test/vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    css: false,
  },
});
