// React entry point. Kept tiny so the component tree (in App.tsx) owns all
// actual logic — main.tsx just wires React to the DOM.
//
// One exception: we apply the persisted theme *before* React mounts so
// users who picked "dark" don't see a flash of the light palette on
// reload. The theme module is framework-free on the write side, which
// makes this safe to call here.

import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, readStoredTheme } from "./lib/theme.ts";
import "./styles/globals.css";

applyTheme(readStoredTheme());

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing from index.html");

// StrictMode intentionally omitted: its dev-only double-invocation of
// effects masked the useRunLive bootstrap-fetch bug (one mount became
// three /messages requests) and inflated memory on long runs by
// re-running every delta-folding effect twice. Production parity in
// dev is more useful here than the extra strict-mode lint.
createRoot(rootEl).render(<App />);
