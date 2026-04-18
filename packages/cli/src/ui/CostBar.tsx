// One-line cost / token ticker — rendered between the graph and the
// stream pane. Reads from the shared `CostTotals` accumulator in
// @swarm/events (same primitive the CLI console tee and the REST
// server's summary both use, so numbers match everywhere).

import type { CostTotals } from "@swarm/events";
import { Box, Text } from "ink";
import type { JSX } from "react";

export interface CostBarProps {
  totals: CostTotals;
  /** Pipeline status — drives the leading glyph + colour. */
  status: "running" | "completed" | "failed" | "canceled" | "pending";
  /** Run id shown at the end for cross-reference with `swarm list`. */
  runId: string;
  /** ISO timestamp of the most recent event (for a "last activity" hint).
   * Optional; omitted when no events have streamed yet. */
  lastActivity?: string;
}

export function CostBar(props: CostBarProps): JSX.Element {
  const { totals, status, runId, lastActivity } = props;
  const glyph = glyphFor(status);
  const colour = colourFor(status);
  const usd = totals.cost_usd.toFixed(4);
  const tokens = `${fmtNum(totals.input_tokens)} in / ${fmtNum(totals.output_tokens)} out`;
  const headProps: { color?: string } = colour !== undefined ? { color: colour } : {};
  return (
    <Box>
      <Text {...headProps}>{glyph} </Text>
      <Text {...headProps}>{status} </Text>
      <Text dimColor>│ </Text>
      <Text>${usd} </Text>
      <Text dimColor>│ </Text>
      <Text>{tokens} </Text>
      <Text dimColor>│ </Text>
      <Text>{totals.calls} calls </Text>
      <Text dimColor>│ </Text>
      <Text dimColor>{runId}</Text>
      {lastActivity !== undefined ? (
        <>
          <Text dimColor> │ </Text>
          <Text dimColor>last {formatAge(lastActivity)}</Text>
        </>
      ) : null}
    </Box>
  );
}

function glyphFor(status: CostBarProps["status"]): string {
  switch (status) {
    case "running":
      return "▶";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "canceled":
      return "⊘";
    default:
      return "·";
  }
}

function colourFor(status: CostBarProps["status"]): string | undefined {
  switch (status) {
    case "running":
      return "magenta";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "canceled":
      return "yellow";
    default:
      return undefined;
  }
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function formatAge(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const ageMs = Date.now() - t;
  if (ageMs < 2_000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}
