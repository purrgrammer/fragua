// EventLog — renders the raw store event stream for a run.
//
// Replaces the old RunConversation for the DB-backed rearchitecture:
// events are fact.* / intent.* shapes, not agent.turn_start / llm.*.
// We display each event as a row with seq, type, and a short payload summary.
//
// Data: polled every 2s via TanStack Query against
// `GET /runs/:id/events.json`. Switch to SSE later if latency matters;
// polling is fine for single-user local deployments and trivially correct.

import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "./ui/empty-state.tsx";

interface StoredEvent {
  runId: string;
  seq: number;
  type: string;
  writer: "daemon" | "web";
  payload: Record<string, unknown>;
  ts: number;
}

export interface EventLogProps {
  runId: string;
  /** Refetch ticker from the parent so live runs stay fresh. */
  refetchKey?: number;
}

export function EventLog({ runId, refetchKey }: EventLogProps): JSX.Element {
  const query = useQuery({
    queryKey: ["run-events", runId, refetchKey],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/events.json`);
      if (!res.ok) throw new Error(`events ${res.status}`);
      return (await res.json()) as StoredEvent[];
    },
    refetchInterval: 2_000,
    staleTime: 0,
  });

  if (query.isPending) {
    return (
      <div data-testid="event-log-loading" className="p-4 text-xs text-muted-foreground">
        Loading events…
      </div>
    );
  }
  if (query.isError) {
    return (
      <EmptyState
        data-testid="event-log-error"
        title="Couldn't load events"
        description="The events endpoint didn't respond. Check the server log for details."
      />
    );
  }
  const events = query.data ?? [];
  if (events.length === 0) {
    return (
      <EmptyState
        data-testid="event-log-empty"
        title="No events yet"
        description="Events will appear here as the run progresses."
      />
    );
  }

  return (
    <ol data-testid="event-log" className="divide-y text-xs font-mono" aria-label="Event log">
      {events.map((event) => (
        <li
          key={event.seq}
          data-testid={`event-row-${event.seq}`}
          className="flex items-start gap-3 px-3 py-1.5"
          data-writer={event.writer}
        >
          <span className="w-10 shrink-0 text-right text-muted-foreground">{event.seq}</span>
          <span className={writerColor(event.writer)}>{symbolFor(event.type)}</span>
          <span className={typeColor(event.type)}>{event.type}</span>
          <span className="min-w-0 flex-1 truncate text-slate-500">{summarize(event.payload)}</span>
          <time className="shrink-0 text-slate-400" dateTime={new Date(event.ts).toISOString()}>
            {formatTime(event.ts)}
          </time>
        </li>
      ))}
    </ol>
  );
}

function symbolFor(type: string): string {
  if (type.startsWith("intent.")) return "→";
  if (type === "fact.run_completed") return "✓";
  if (type === "fact.run_halted" || type === "fact.run_cancelled") return "✗";
  if (type === "fact.run_paused_hitl") return "⏸";
  if (type === "fact.run_quarantined") return "⚠";
  if (type.startsWith("fact.node_")) return "▸";
  return "·";
}

function typeColor(type: string): string {
  if (type.startsWith("intent.")) return "text-blue-600";
  if (type === "fact.run_completed") return "text-emerald-600";
  if (type === "fact.run_halted" || type === "fact.run_cancelled") return "text-rose-600";
  if (type === "fact.run_paused_hitl" || type === "fact.run_quarantined") return "text-amber-600";
  return "text-slate-700 dark:text-slate-300";
}

function writerColor(writer: "daemon" | "web"): string {
  return writer === "daemon" ? "text-slate-400" : "text-blue-400";
}

function summarize(payload: Record<string, unknown>): string {
  if (payload == null) return "";
  const keys = Object.keys(payload);
  if (keys.length === 0) return "";
  const first3 = keys.slice(0, 3);
  const parts = first3.map((k) => `${k}=${shortValue(payload[k])}`);
  return parts.join(" ");
}

function shortValue(v: unknown): string {
  if (typeof v === "string") return v.length > 32 ? `${v.slice(0, 29)}…` : v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (typeof v === "boolean") return String(v);
  if (v == null) return "null";
  return "…";
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
