---
name: design
description: "Swarm UI design language for packages/web. Load this skill before writing or modifying any React/TSX component, CSS, style, or theme token in packages/web — including small changes like a button class, spacing, color, font size, radius, or animation, and any time you're choosing between a shadcn token (bg-card, text-foreground) and a Swarm token (bg-sw-surface, text-sw-muted, rounded-sw-card). The web UI is on Tailwind v4 with CSS-first config: there is no tailwind.config.ts, theme tokens live in globals.css's @theme inline block, dark mode is a @custom-variant on .dark. Encodes the 'clarity through restraint' philosophy: monospace voice, data-as-decor (no shadows/gradients), bento layouts with hairline borders, semantic color reserved strictly for state, light-mode default with both themes first-class, and motion that indicates state rather than decorates."
version: 0.3.0
---

# Swarm design language

*Clarity through restraint — data is the decoration, structure is the grid, motion indicates state.*

Foundational language for `packages/web`. If a pattern isn't here, derive it from the principles. When principles conflict, **restraint wins** — the default answer to "should I add something" is no.

---

## Principles (earlier wins on conflict)

1. **Calm control & progressive disclosure.** Surface status and the 2–3 numbers that matter. Logs, metadata, and secondary actions live behind hover, tooltip, or drawer. More than ~7 primary signals per view is failure.
2. **Data as decor.** Sparklines, status dots, and aligned numbers *are* the visual rhythm. No shadows, decorative gradients, or heavy borders. Ornament gets deleted.
3. **Strict structural layout.** Bento grid, tight consistent padding, sections separated by a hairline — never by a different background shade. Flex rows for micro-data: `[status] [name] [metric]`.
4. **Typographic discipline.** Monospace voice. Hierarchy via weight, case, and spacing — never size jumps. Numbers always tabular.
5. **Restrained semantic color.** Surfaces nearly indistinguishable from background. Accents reserved for state — not branding.
6. **Functional motion.** Motion says "this is happening." If removing it loses no information, remove it.

---

## Stack & how tokens fit the codebase

**Tailwind v4, CSS-first config.** There is no `tailwind.config.ts`. All theme mapping lives in `packages/web/src/styles/globals.css` inside an `@theme inline { … }` block; raw design-language CSS vars live in `packages/web/src/styles/theme.css`. The build pipeline is `@tailwindcss/vite` (no PostCSS, no Autoprefixer — v4 handles vendor prefixing via Lightning CSS). Animations come from `tw-animate-css` (imported as `@import "tw-animate-css";` in globals).

Two token layers coexist. Know which to reach for before writing a class:

- **`--sw-*` (Swarm design language)** — defined in `theme.css`. Surfaces, state accents, typography scale, spacing scale, radii, motion durations. Exposed as Tailwind utilities via `@theme inline`: **`bg-sw-surface`**, **`text-sw-muted`**, **`border-sw-border`**, **`bg-sw-accent-thinking`**, **`rounded-sw-card`**, **`text-sw-md`**, etc. **Reach here first** for product surfaces.
- **shadcn vars (no prefix: `--background`, `--foreground`, `--card`, `--muted`, `--border`, `--popover`, `--sidebar*`)** — baseline the bundled shadcn / AI Elements components are wired to. Exposed as Tailwind utilities too (`bg-card`, `text-foreground`, `border-border`, `bg-sidebar`). Don't fight them inside shadcn primitives; match them when extending those primitives.

Rule of thumb: **pick one layer per element's visual identity.** A bento cell you're authoring → `bg-sw-surface` + `border-sw-border`. A shadcn `<Dialog>` you're skinning → shadcn tokens. Mixing the two inside one element's palette is how the design drifts.

### Already enforced globally — don't re-implement

In `globals.css`:

- `box-shadow: none` on `*` — elevation isn't a tool available to you, by design.
- `border-radius: var(--sw-radius-default, 2px)` default on `*`.
- `font-variant-numeric: tabular-nums` + `"tnum" 1` on body — numbers are tabular everywhere.
- `html, body` inherit the mono stack via `--font-mono`.
- Tailwind's default `text-base` is rebound onto `--sw-text-sm` so stray `text-base` follows the Swarm scale rather than jumping to 16px.
- **`.sw-pulse` utility** — 1.0 → 0.55 → 1.0 opacity, 1800ms, respects `prefers-reduced-motion`. Use this; don't hand-roll keyframes for "thinking."
- **`dark` variant** wired via `@custom-variant dark (&:where(.dark, .dark *))` — `dark:bg-…` works off a `class="dark"` anywhere up the tree.

### v4 idioms to prefer, v3 relics to avoid

- Config belongs in CSS (`@theme inline`), not a `.ts` file. If you need a new theme token, add it to `@theme inline` in `globals.css`, not a new config file.
- Scan paths use `@source "…"` inside `globals.css` (already wired for streamdown). Don't reach for a `content: []` array — no config file exists.
- Plugins load via `@import "tw-animate-css"` / `@plugin "…"` in CSS. Don't `import animate from "tailwindcss-animate"` — that package is gone.
- `@apply` still works for shared bits (e.g., `border-border` on `*`), but prefer token utilities in JSX.

---

## Themes

**Light is the default.** Swarm flips the dev-tool dark convention. Dark is a peer; every token has both values in `theme.css` (`:root` vs `.dark`), both intentionally designed — not auto-inverted.

Both modes share the vibe: **low contrast between surface layers**. A card and the page are nearly the same value — separation is a 1px hairline, not a lighter panel.

---

## Color

Accents communicate state. No decorative accents. No "primary" color that isn't a state. Desaturate 15–30% from the first guess. No gradients on surfaces (inside a sparkline is fine). Status dots carry the color; labels stay `text-sw-text` or `text-sw-muted`.

| Token (CSS var)         | Tailwind utility prefix          | Vibe                                        | Use for                           |
|-------------------------|----------------------------------|---------------------------------------------|-----------------------------------|
| `--sw-bg`               | `bg-sw-bg`                       | Near-paper (light) / near-ink (dark)        | Page, root                        |
| `--sw-surface`          | `bg-sw-surface`                  | One notch off bg, barely perceptible        | Cards, panels, drawers            |
| `--sw-border`           | `border-sw-border`               | Hairline, visible but quiet                 | Section edges                     |
| `--sw-text`             | `text-sw-text`                   | High legibility, never pure black/white     | Copy, numerics                    |
| `--sw-muted`            | `text-sw-muted`                  | Dimmed, still readable                      | Labels, secondary metadata        |
| `--sw-accent-success`   | `bg-sw-accent-success`           | Calm green, not lime                        | Done, healthy, passed             |
| `--sw-accent-error`     | `bg-sw-accent-error`             | Serious red, not neon                       | Failure, blocker, over-budget     |
| `--sw-accent-thinking`  | `bg-sw-accent-thinking`          | Warm amber — the "alive" color              | Processing, awaiting, streaming   |
| `--sw-accent-idle`      | `bg-sw-accent-idle`              | Neutral gray                                | Queued, paused                    |
| `--sw-accent-warn`      | `bg-sw-accent-warn`              | Muted orange                                | Resource pressure, soft threshold |

Never hex literals. Prefer the Tailwind utility; drop to `style={{ color: 'var(--sw-accent-error)' }}` only when a utility doesn't exist (e.g., gradient stop, box-shadow mask).

---

## Typography

Monospace is the voice. Body already inherits the mono stack from `:root`. Don't reach for Tailwind's `font-sans` on product surfaces just because shadcn ships with it — `font-sans` is Geist, bound that way only for shadcn's own internals.

**Stack** (in `--font-mono`):

```
"Berkeley Mono", "JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace
```

**Scale.** Hierarchy is weight, case, and spacing — not size. Exposed as Tailwind utilities; use those.

| CSS var          | Tailwind utility | px | Use                                      |
|------------------|------------------|----|------------------------------------------|
| `--sw-text-xs`   | `text-sw-xs`     | 13 | Timestamps, dense metadata               |
| `--sw-text-sm`   | `text-sw-sm`     | 15 | **Default body** (already on root)       |
| `--sw-text-base` | `text-sw-base`   | 16 | Emphasized body, primary metric values   |
| `--sw-text-md`   | `text-sw-md`     | 18 | Section headings                         |
| `--sw-text-lg`   | `text-sw-lg`     | 22 | Page title — one per screen              |

**Weights.** 400, 500, 600. No 700+. No italics except inline code in prose.

**Case.** `UPPERCASE` with ~0.06em letter-spacing for section labels and column headers. Sentence case elsewhere. **Never Title Case.**

**Line-height.** 1.4 body, 1.2 headings, 1.0 for dense numeric tables.

Tabular figures are global — don't add `tabular-nums` redundantly, but also don't disable them.

---

## Spacing

4px base. These steps only — no arbitrary px.

| CSS var         | Tailwind (matches)  | px | Use                                  |
|-----------------|---------------------|----|--------------------------------------|
| `--sw-space-05` | `p-0.5` / `gap-0.5` | 2  | Icon-to-label                        |
| `--sw-space-1`  | `p-1` / `gap-1`     | 4  | Row gap, button padding-y            |
| `--sw-space-2`  | `p-2` / `gap-2`     | 8  | Card padding, input padding-x        |
| `--sw-space-3`  | `p-3` / `gap-3`     | 12 | Card padding-y, section internal gap |
| `--sw-space-4`  | `p-4` / `gap-4`     | 16 | Card-to-card, panel padding          |
| `--sw-space-6`  | `p-6` / `gap-6`     | 24 | Page gutter                          |
| `--sw-space-8`  | `p-8` / `gap-8`     | 32 | Large region separation              |

Tailwind's default `--spacing` base is 4px, so `p-3` is exactly `--sw-space-3`. **Prefer the Tailwind utility.** Drop to `p-[var(--sw-space-3)]` only if you need the var reference for a calc or a non-spacing property.

First drafts should feel slightly too tight. Air comes from alignment, not margin.

---

## Borders & elevation

- **1px only**, `border-sw-border`. Tone shifts by theme, width never.
- **Radius:** `rounded-sw-default` (2px) default, `rounded-sw-card` (4px) for cards/drawers, `rounded-sw-none` (0) for table rows and dense stacks. Pills only where the pill *is* the status shape.
- **Elevation: none.** `box-shadow: none` is already set on `*`. Drawers separate via backdrop scrim + hairline. Reaching for shadow means you need more spacing or a hairline.

---

## Layout

- **Bento grid.** Rectangles divided by hairlines, sized by content weight, not equal thirds.
- **Flex rows** for micro-data: `[status-dot] [name — flex:1] [metric — tabular, right-aligned]`.
- **Consistent padding** inside every cell — `p-3` for a status card and a log card alike. Don't vary padding by "importance."

---

## Motion

Only animate `transform` and `opacity`. Paired elements (drawer + scrim, tooltip + arrow) share easing and duration. Motion durations are exposed as CSS vars so timings stay uniform across components — reach for them in `transition-*` arbitrary values (`duration-[var(--sw-duration-hover)]`).

| State                     | Animation                         | Token / duration                 | Easing        |
|---------------------------|-----------------------------------|----------------------------------|---------------|
| Processing / awaiting     | Opacity pulse 1.0 → 0.55 → 1.0    | `--sw-duration-pulse` (1800ms)   | `ease-in-out` |
| Drawer / panel enter-exit | Slide + fade (paired with scrim)  | `--sw-duration-enter` (200ms)    | `ease-out`    |
| Status transition         | Dot color crossfade               | `--sw-duration-status` (160ms)   | `ease`        |
| Numeric update in place   | Roll or crossfade                 | 200ms                            | `ease-in-out` |
| Hover, color shift        | Bg + border shift                 | `--sw-duration-hover` (120ms)    | `ease`        |
| Active / press            | `transform: scale(0.97)`          | `--sw-duration-press` (80ms)     | `ease-out`    |
| Focus ring                | Instant                           | 0ms                              | —             |

Rules:

- **Use `.sw-pulse`** for all "thinking/streaming/awaiting" indicators. It already handles duration and `prefers-reduced-motion`.
- **Use `tw-animate-css`** utilities for entrance/exit on shadcn primitives (`animate-in`, `fade-in-0`, `slide-in-from-top-2`, etc.). Don't hand-roll keyframes for these.
- **Easing by intent.** `ease-out` enter/exit; `ease-in-out` on-screen morph; `ease` hover and color; `linear` only for constant-motion indicators — never for color.
- **Pulse is slow.** A fast pulse reads as error.
- **High-frequency numerics.** If a counter updates >5×/sec, batch to ~200ms ticks before animating — don't stack crossfades.
- **`prefers-reduced-motion`:** for anything you author outside `.sw-pulse`, swap pulse for static dimmed state, disable rolls, keep hovers (they're informational).
- **Hover on hot rows.** Omit hover animation on list rows users traverse hundreds of times per session. Keep it on buttons.

---

## A conforming component (sketch)

A bento cell — status dot, name, metric. Shows the common v4 moves:

```tsx
<div className="flex items-center gap-2 p-3 border border-sw-border rounded-sw-card bg-sw-surface">
  <span
    aria-hidden
    className="sw-pulse size-2 rounded-full bg-sw-accent-thinking"
  />
  <span className="flex-1 truncate text-sw-sm">agent-3</span>
  <span className="text-sw-base">1,284</span>
</div>
```

What's doing the work: mono inherited from root, no shadow (global), 1px hairline via `border-sw-border`, 12px padding (`p-3`), tabular-nums global, status carried by the dot's color not the label's, pulse that respects reduced motion — all expressed as first-class Tailwind utilities, no `style={{}}` escape hatch needed.

---

## Authoring checklist

- [ ] No `box-shadow`, no decorative gradient, no border ≥ 2px
- [ ] No hex literals — `sw-*` or shadcn token utilities only
- [ ] Picked **one** token layer (Swarm or shadcn), not both, for the element's palette
- [ ] Every accent maps to a state
- [ ] Padding and radius are tokens (`p-3`, `rounded-sw-card`)
- [ ] Font size uses the scale (`text-sw-sm` / `text-sw-md` / …), never raw `text-base` / `text-lg` / px values
- [ ] Hierarchy survives the desaturate test (works if you strip color)
- [ ] Both themes verified — not just light
- [ ] Secondary info behind hover / drawer
- [ ] Live-updating numbers have a transition
- [ ] Processing elements use `.sw-pulse`
- [ ] Animations touch only `transform` and `opacity`
- [ ] No `font-sans` on a product surface

---

## Anti-patterns

- Shadow to separate cards → hairline. (And `box-shadow: none` is already global — if you see one, something is fighting the reset.)
- Background shade for hierarchy → same surface, hairline.
- Icon-only status → always label.
- "Primary" color that isn't a state → no brand-blue buttons.
- `font-sans` on product surfaces because shadcn has it → inherit mono.
- Mixing `sw-*` and shadcn tokens inside one element's palette → pick a layer.
- Hex literals, `#fff`, `#000` → token utilities only.
- Giant headings → weight + case do the work.
- Welcome-theater animation on load → motion is for state.
- Linear easing on color or hover → use `ease`.
- Hand-rolled "thinking" keyframes → use `.sw-pulse`.
- Reaching for `tailwindcss-animate` or a `tailwind.config.ts` → both gone under v4; use `tw-animate-css` utilities and `@theme inline`.
- Title Case anywhere.
