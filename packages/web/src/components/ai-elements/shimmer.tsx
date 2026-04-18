"use client";

import type { CSSProperties, ElementType } from "react";
import { createElement, memo } from "react";
import { cn } from "@/lib/utils";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  /**
   * Pulse duration in seconds. Floored to the design system's pulse
   * token (1.8s) — anything faster reads as error. Pulse is slow;
   * 1800ms floor, a fast pulse reads as error.
   */
  duration?: number;
  /**
   * Retained for API parity. The Swarm design language has no decorative
   * shimmer band ("No gradients on surfaces"; "Data as decor"); the
   * `.sw-pulse` opacity oscillation carries the "this is happening"
   * signal instead.
   */
  spread?: number;
}

// Pulse is slow. 1800ms floor.
const MIN_PULSE_MS = 1800;

const ShimmerComponent = ({
  children,
  as: Component = "p" as ElementType,
  className,
  duration,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: kept for API parity
  spread: _spread,
}: TextShimmerProps) => {
  const requested = duration ? duration * 1000 : MIN_PULSE_MS;
  const pulseMs = Math.max(MIN_PULSE_MS, requested);

  // accent.thinking is the canonical "alive" colour for processing /
  // awaiting / streaming. The `.sw-pulse` class (opacity 1.0 → 0.55 →
  // 1.0, ease-in-out, infinite) is the canonical processing motion and
  // ships with a reduced-motion fallback in globals.css.
  return createElement(
    Component,
    {
      className: cn("sw-pulse inline-block", className),
      style: {
        color: "var(--sw-accent-thinking)",
        animationDuration: `${pulseMs}ms`,
      } as CSSProperties,
    },
    children,
  );
};

export const Shimmer = memo(ShimmerComponent);
