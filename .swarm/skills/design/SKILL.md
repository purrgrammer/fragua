---
name: design
description: Swarm UI design language for packages/web. Load this skill before writing or modifying any React/TSX component, CSS, style, or theme token in packages/web — including small changes like a button class, spacing, color, font size, or animation. Encodes the "clarity through restraint" philosophy: monospace-only typography, data-as-decor (no shadows/gradients), bento layouts with hairline borders, semantic color reserved strictly for state, light-mode default with both themes first-class, and motion that indicates state rather than decorates.
version: 0.1.0
---

# Swarm design language

*Clarity through restraint — data is the decoration, structure is the grid, motion indicates state.*

Foundational language only. If a pattern isn't here, derive it from the principles.

---

## Principles (earlier wins on conflict)

1. **Calm control & progressive disclosure.** Surface status and the 2–3 numbers that matter. Logs, metadata, and secondary actions live behind hover, tooltip, or drawer. More than ~7 primary signals per view is failure.
2. **Data as decor.** Sparklines, status dots, and aligned numbers *are* the visual rhythm. No shadows, decorative gradients, or heavy borders. Ornament gets deleted.
3. **Strict structural layout.** Bento grid, tight consistent padding, sections separated by a hairline — never by a different background shade. Flex rows for micro-data: `[status] [name] [metric]`.
4. **Typographic discipline.** Monospace only. Hierarchy via weight, case, and spacing — never size jumps. Numbers always tabular.
5. **Restrained semantic color.** Surfaces nearly indistinguishable from background. Accents reserved for state — not branding.
6. **Functional motion.** Motion says "this is happening." If removing it loses no information, remove it.

---

## Themes

**Light is the default.** Swarm flips the dev-tool dark convention. Dark is a peer; every token has both values, both intentionally designed, not auto-inverted.

Both modes share the vibe: **low contrast between surface layers**. A card and the page are nearly the same value — separation is a 1px hairline, not a lighter panel.

---

## Color (vibe, no hex)

Components reference theme tokens. Values live in the theme layer.

| Token             | Vibe                                           | Use for                         |
|-------------------|------------------------------------------------|---------------------------------|
| `bg`              | Near-paper (light) / near-ink (dark)           | Page, root                      |
| `surface`         | One notch off `bg`, barely perceptible         | Cards, panels, drawers          |
| `border`          | Hairline, visible but quiet                    | Section edges                   |
| `text`            | High legibility, never pure black/white        | Copy, numerics                  |
| `muted`           | Dimmed, still readable                         | Labels, secondary metadata      |
| `accent.success`  | Calm green, not lime                           | Done, healthy, passed           |
| `accent.error`    | Serious red, not neon                          | Failure, blocker, over-budget   |
| `accent.thinking` | Warm amber or soft blue — the "alive" color    | Processing, awaiting, streaming |
| `accent.idle`     | Neutral gray                                   | Queued, paused                  |
| `accent.warn`     | Muted orange                                   | Resource pressure, soft threshold |

Rules:

- Accents communicate state. No decorative accents. No "primary" color that isn't a state.
- Desaturate 15–30% from the first guess.
- No gradients on surfaces (inside a sparkline is fine).
- Status dots carry the color; labels stay `text` or `muted`.

---

## Typography

**Stack.**

```
"Berkeley Mono", "JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace
```

**Scale.** Hierarchy is weight, case, and spacing — not size.

| Token  | px | Use                                      |
|--------|----|------------------------------------------|
| `xs`   | 11 | Timestamps, dense metadata               |
| `sm`   | 12 | **Default body**                         |
| `base` | 13 | Emphasized body, primary metric values   |
| `md`   | 15 | Section headings                         |
| `lg`   | 18 | Page title — one per screen              |

**Weights.** 400, 500, 600. No 700+. No italics except inline code in prose.

**Case.** `UPPERCASE` with ~0.06em letter-spacing for section labels and column headers. Sentence case elsewhere. **Never Title Case.**

**Tabular figures, global:**

```css
body {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}
```

**Line-height.** 1.4 body, 1.2 headings, 1.0 for dense numeric tables.

---

## Spacing

4px base. These steps only — no arbitrary px.

| Token | px | Use                                   |
|-------|----|---------------------------------------|
| `0.5` | 2  | Icon-to-label                         |
| `1`   | 4  | Row gap, button padding-y             |
| `2`   | 8  | Card padding, input padding-x         |
| `3`   | 12 | Card padding-y, section internal gap  |
| `4`   | 16 | Card-to-card, panel padding           |
| `6`   | 24 | Page gutter                           |
| `8`   | 32 | Large region separation               |

First drafts should feel slightly too tight. Air comes from alignment, not margin.

---

## Borders & elevation

- **1px only**, `border` token. Tone shifts by theme, width never.
- **Radius:** 2px default, 4px cards/drawers, 0px for table rows and dense stacks. Pills only where the pill *is* the status shape.
- **Elevation: none.** No `box-shadow`. Drawers separate via backdrop scrim + hairline. Reaching for shadow means you need more spacing or a hairline.

---

## Layout

- **Bento grid.** Rectangles divided by hairlines, sized by content weight, not equal thirds.
- **Flex rows** for micro-data: `[status-dot] [name — flex:1] [metric — tabular, right-aligned]`.
- **Consistent padding** inside every cell — `spacing.3` for a status card and a log card alike. Don't vary by "importance."

---

## Motion

Only animate `transform` and `opacity`. Paired elements (drawer + scrim, tooltip + arrow) share easing and duration.

| State                          | Animation                         | Duration         | Easing        |
|--------------------------------|-----------------------------------|------------------|---------------|
| Processing / awaiting          | Opacity pulse 1.0 → 0.55 → 1.0    | 1800ms, infinite | `ease-in-out` |
| Drawer / panel enter-exit      | Slide + fade (paired with scrim)  | 200ms            | `ease-out`    |
| Status transition              | Dot color crossfade               | 160ms            | `ease`        |
| Numeric update in place        | Roll or crossfade                 | 200ms            | `ease-in-out` |
| Hover, color shift             | Bg + border shift                 | 120ms            | `ease`        |
| Active / press                 | `transform: scale(0.97)`          | 80ms             | `ease-out`    |
| Focus ring                     | Instant                           | 0ms              | —             |

Rules:

- **Easing by intent.** `ease-out` for enter/exit; `ease-in-out` for on-screen morph; `ease` for hover and color; `linear` only for constant-motion indicators — never for color.
- **Pulse is slow.** 1800ms floor; 2200ms fine for less urgent "thinking." A fast pulse reads as error.
- **High-frequency numerics.** If a counter updates >5×/sec, batch to ~200ms ticks before animating — don't stack crossfades.
- **`prefers-reduced-motion`:** swap pulse for static dimmed state, disable rolls, keep hovers (they're informational).
- **Hover on hot rows.** Omit hover animation on list rows users traverse hundreds of times per session. Keep it on buttons.

---

## Authoring checklist

- [ ] No `box-shadow`, no gradient, no border ≥ 2px
- [ ] No hex literals — theme tokens only
- [ ] Numerics use tabular figures
- [ ] Every accent maps to a state
- [ ] Padding is a token
- [ ] Hierarchy survives the desaturate test
- [ ] Both themes designed, not auto-inverted
- [ ] Secondary info behind hover / drawer
- [ ] Live-updating numbers have a transition
- [ ] Processing elements pulse, with `prefers-reduced-motion` fallback
- [ ] Animations touch only `transform` and `opacity`

---

## Anti-patterns

- Shadow to separate cards → hairline.
- Background shade for hierarchy → same surface, hairline.
- Icon-only status → always label.
- "Primary" color that isn't a state → no brand-blue buttons.
- Sans-serif mixed in for "readability" → monospace is the voice.
- Giant headings → weight + case do the work.
- Welcome-theater animation on load → motion is for state.
- Linear easing on color or hover → use `ease`.
- Title Case anywhere.

---

## When principles conflict

Restraint wins. Default answer to "should I add something" is no.
