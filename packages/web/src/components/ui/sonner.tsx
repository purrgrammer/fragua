import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "../../lib/theme.ts";

/**
 * Drop-in `<Toaster />` styled with Fragua design-language tokens.
 *
 * Mount once at the app root (inside QueryClientProvider, outside the
 * router) so the portal survives navigation and toast lifetime is
 * decoupled from any single route.
 *
 * `richColors` is disabled — we paint via `--sw-accent-*` CSS vars so
 * every toast uses the same restrained palette as the rest of the UI
 * rather than sonner's vivid defaults.
 */
export function Toaster(): JSX.Element {
  const { resolved } = useTheme();

  return (
    <SonnerToaster
      theme={resolved}
      position="top-right"
      closeButton
      richColors={false}
      toastOptions={{
        classNames: {
          toast:
            "!bg-[var(--sw-surface)] !text-[var(--sw-text)] !border-[var(--sw-border)] !rounded-[var(--sw-radius-card)] !font-sans !text-sm !shadow-none",
          title: "!font-medium",
          description: "!text-[var(--sw-muted)] !text-xs",
          closeButton:
            "!bg-[var(--sw-surface)] !text-[var(--sw-muted)] !border-[var(--sw-border)] hover:!text-[var(--sw-text)]",
          success: "!border-l-[3px] !border-l-[var(--sw-accent-success)]",
          error: "!border-l-[3px] !border-l-[var(--sw-accent-error)]",
          warning: "!border-l-[3px] !border-l-[var(--sw-accent-warn)]",
          info: "!border-l-[3px] !border-l-[var(--sw-accent-idle)]",
        },
      }}
    />
  );
}
