# Design revamp progress

Mission: Audit and refactor packages/web against six Swarm design principles—calm control, data as decor, structural layout, typographic discipline, semantic color, functional motion—with minimum-diff component fixes, theme-token-only styling, and explicit dual-theme design.

Skill sha: `ee2cf77064c2ff226cddc6d3108501dd3c1ccafa7495e54480d4a9381e15d539`

## Foundation
- [x] packages/web/src/styles/theme.css (--sw-* tokens: Color, Typography, Spacing — light :root + dark .dark peer)
- [x] packages/web/src/styles/globals.css (monospace stack, tabular-nums, 12px base, 1.4 line-height, box-shadow reset, 2px radius default)

## UI Primitives (shared)
- [x] packages/web/src/components/ui/button.tsx
- [x] packages/web/src/components/ui/card.tsx
- [x] packages/web/src/components/ui/badge.tsx
- [x] packages/web/src/components/ui/separator.tsx
- [x] packages/web/src/components/ui/input.tsx
- [x] packages/web/src/components/ui/input-group.tsx
- [x] packages/web/src/components/ui/textarea.tsx
- [x] packages/web/src/components/ui/spinner.tsx
- [x] packages/web/src/components/ui/skeleton.tsx
- [x] packages/web/src/components/ui/tooltip.tsx
- [x] packages/web/src/components/ui/hover-card.tsx
- [x] packages/web/src/components/ui/dialog.tsx
- [x] packages/web/src/components/ui/command.tsx
- [x] packages/web/src/components/ui/select.tsx
- [x] packages/web/src/components/ui/dropdown-menu.tsx
- [x] packages/web/src/components/ui/breadcrumb.tsx
- [x] packages/web/src/components/ui/button-group.tsx
- [x] packages/web/src/components/ui/scroll-area.tsx
- [x] packages/web/src/components/ui/collapsible.tsx
- [x] packages/web/src/components/ui/table.tsx
- [x] packages/web/src/components/ui/sidebar.tsx
- [x] packages/web/src/components/ui/empty-state.tsx

## AI Elements (shared visual language)
- [x] packages/web/src/components/ai-elements/shimmer.tsx
- [x] packages/web/src/components/ai-elements/spinner.tsx _(N/A — file does not exist; only `ui/spinner.tsx` exists, already revamped)_
- [x] packages/web/src/components/ai-elements/task.tsx
- [x] packages/web/src/components/ai-elements/checkpoint.tsx
- [x] packages/web/src/components/ai-elements/code-block.tsx
- [x] packages/web/src/components/ai-elements/message.tsx
- [x] packages/web/src/components/ai-elements/reasoning.tsx
- [x] packages/web/src/components/ai-elements/suggestion.tsx
- [ ] packages/web/src/components/ai-elements/tool.tsx
- [ ] packages/web/src/components/ai-elements/toolbar.tsx
- [ ] packages/web/src/components/ai-elements/controls.tsx
- [ ] packages/web/src/components/ai-elements/prompt-input.tsx
- [ ] packages/web/src/components/ai-elements/panel.tsx
- [ ] packages/web/src/components/ai-elements/conversation.tsx
- [ ] packages/web/src/components/ai-elements/canvas.tsx
- [ ] packages/web/src/components/ai-elements/connection.tsx
- [ ] packages/web/src/components/ai-elements/edge.tsx
- [ ] packages/web/src/components/ai-elements/node.tsx

## Shell & Layout
- [ ] packages/web/src/components/AppShell.tsx
- [ ] packages/web/src/components/AppSidebar.tsx
- [ ] packages/web/src/App.tsx

## Routes (traffic order)
- [ ] packages/web/src/routes/Home.tsx
- [ ] packages/web/src/routes/PipelinesList.tsx
- [ ] packages/web/src/routes/PipelineDetail.tsx
- [ ] packages/web/src/routes/SkillsList.tsx
- [ ] packages/web/src/routes/SkillDetail.tsx
- [ ] packages/web/src/routes/Settings.tsx
- [ ] packages/web/src/routes/Workflows.tsx

## Component Details
- [ ] packages/web/src/components/PipelineRow.tsx
- [ ] packages/web/src/components/StepInspector.tsx
- [ ] packages/web/src/components/PipelineConversation.tsx
- [ ] packages/web/src/components/GraphView.tsx
- [ ] packages/web/src/components/HealthBadge.tsx

---

**Principles checklist** (cite in every commit):
1. ✓ Calm control & progressive disclosure — surface 2–3 key signals, secondary data behind hover/tooltip/drawer
2. ✓ Data as decor — no shadows, gradients, or ornament; sparklines and status dots are the rhythm
3. ✓ Strict structural layout — bento grid, hairline borders (1px only), consistent padding tokens
4. ✓ Typographic discipline — monospace only, hierarchy via weight/case/spacing, tabular figures
5. ✓ Restrained semantic color — surfaces near-indistinguishable, accents = state only
6. ✓ Functional motion — transform/opacity only, easing by intent, pulse ≥1800ms, prefers-reduced-motion support

**Anti-patterns to delete:**
- `box-shadow` → delete
- Gradients on surfaces → delete
- Hex literals → replace with token
- Background-shade hierarchy → replace with hairline
- Size-based heading hierarchy → replace with weight + case
- Decorative animation on load → delete
- Sans-serif mixed in → delete
- Title Case → replace with Sentence case or UPPERCASE labels
