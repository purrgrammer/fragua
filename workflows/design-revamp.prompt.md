Revamp packages/web to fully align with the Swarm design language at .swarm/skills/design/SKILL.md. Every existing visual and styling decision is up for review — colors, typography, spacing, borders, shadows, animations, information density, progressive disclosure.

Method. For each component, audit against the skill's six principles, then apply the minimum diff that resolves every violation. Use only theme tokens; no hex literals. Light mode is default and must be explicitly designed; dark mode is a peer and must be explicitly designed — never auto-invert.

Scope. Visual and structural refactor only. Preserve component behavior and props. You MAY move secondary information behind hover or drawer when the `calm control & progressive disclosure` principle is clearly violated — when you do, call it out in the commit body so humans can catch up.

Bias. Restraint wins on every conflict. Default answer to "should I add something" is no. Prefer deletion over addition: if an element exists purely to decorate, remove it. Monospace is the voice; accents are reserved for state; hairlines replace shadows; padding snaps to the token scale.

Quality bar. Every change must cite a specific skill rule. A subagent reviewer enforces this per component and its verdict is recorded: unresolved rejections go into a `REVIEW_NOTES:` trailer on the commit so the loop doesn't stall and humans can audit later.

Progress. One commit per component. The worklist at .swarm/design-revamp-progress.md tracks state and is ticked as each item lands, so the run is safely resumable.
