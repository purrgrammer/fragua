// Streaming event pane — bottom half of the TUI. Renders a rolling window
// of the most recent swarm events in a colour-coded single-line format
// (mirrors `ConsoleSink.formatEvent` style so the TUI and the `swarm run`
// console tee look the same).
//
// We keep a fixed-size ring in the parent component and just render it;
// the rolling logic lives with the reducer, not here, so the component
// stays pure-render.

import { Box, Text } from "ink";
import type { JSX } from "react";

export interface StreamLine {
  /** Monotonically-increasing id — for React keys. */
  id: number;
  /** Human-readable text; may include a leading symbol. */
  text: string;
  /** Optional chalk-equivalent Ink colour. */
  color?: string;
  /** Render dim (used for low-priority events). */
  dim?: boolean;
}

export interface StreamPaneProps {
  lines: readonly StreamLine[];
  /** How many rows of terminal space to reserve. Content overflowing the
   * height is simply the newest `height` lines — there's no scroll-back;
   * users wanting history can read `events.jsonl` directly. */
  height: number;
}

export function StreamPane(props: StreamPaneProps): JSX.Element {
  const { lines, height } = props;
  // Keep only the last `height` lines so Ink doesn't over-draw.
  const visible = lines.length <= height ? lines : lines.slice(lines.length - height);
  return (
    <Box flexDirection="column" height={height}>
      {visible.map((l) => {
        const tp: { color?: string; dimColor?: boolean } = {};
        if (l.color !== undefined) tp.color = l.color;
        if (l.dim === true) tp.dimColor = true;
        return (
          <Text key={l.id} {...tp}>
            {l.text}
          </Text>
        );
      })}
    </Box>
  );
}
