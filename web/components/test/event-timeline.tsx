"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, StatusDot } from "@/components/ui/badge";
import type { RequestEvent, RequestEventType } from "@/lib/test-events";

interface EventTimelineProps {
  events: RequestEvent[];
  live: boolean;
  onClear: () => void;
  /** Tighter chrome for embedding under composer/tools */
  compact?: boolean;
}

export function EventTimeline(props: EventTimelineProps): React.ReactElement {
  const compact = props.compact === true;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<number | undefined>(undefined);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  useEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [props.events, autoScroll]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={
          compact
            ? "flex items-center justify-between border-b border-ink-500 px-3 py-1.5"
            : "flex items-center justify-between border-b border-ink-500 px-4 py-2"
        }
      >
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
          <StatusDot tone={props.live ? "phosphor" : "muted"} />
          {props.live ? "live" : "idle"} · {props.events.length} events
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoScroll((v) => !v)}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-300 hover:text-bone-900"
          >
            {autoScroll ? "pause scroll" : "auto-scroll"}
          </button>
          <button
            onClick={props.onClear}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-300 hover:text-alert-500"
          >
            clear
          </button>
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto">
        {props.events.length === 0 ? (
          <div
            className={
              compact
                ? "py-6 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300"
                : "py-16 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300"
            }
          >
            awaiting request
          </div>
        ) : null}
        <ol className="divide-y divide-ink-500">
          {props.events.map((event, index) => (
            <EventRow
              key={index}
              event={event}
              isExpanded={expanded === index}
              onToggle={() =>
                setExpanded((curr) => (curr === index ? undefined : index))
              }
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

function EventRow({
  event,
  isExpanded,
  onToggle,
}: {
  event: RequestEvent;
  isExpanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const meta = classify(event.type);
  return (
    <li>
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-2 text-left font-mono hover:bg-ink-700/60"
      >
        <span className="pt-0.5">
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-[11px] text-bone-900 block truncate">
            {summarize(event)}
          </span>
          <span className="text-[10px] text-bone-300">
            {new Date(event.at).toLocaleTimeString()}
          </span>
        </span>
      </button>
      {isExpanded ? (
        <pre className="border-t border-ink-500 bg-ink-900/60 px-4 py-2 font-mono text-[10px] leading-5 text-bone-500 whitespace-pre-wrap break-all">
          {JSON.stringify(event, null, 2)}
        </pre>
      ) : null}
    </li>
  );
}

function classify(type: RequestEventType): {
  label: string;
  tone: "phosphor" | "bone" | "warning" | "danger" | "muted";
} {
  switch (type) {
    case "request.started":
      return { label: "start", tone: "bone" };
    case "request.finished":
      return { label: "end", tone: "bone" };
    case "route.attempted":
      return { label: "route", tone: "bone" };
    case "route.succeeded":
      return { label: "ok", tone: "phosphor" };
    case "route.failed":
      return { label: "fail", tone: "danger" };
    case "key.cooldown":
      return { label: "cooldown", tone: "warning" };
    case "autofix.applied":
      return { label: "autofix", tone: "warning" };
    case "enforce.injected":
      return { label: "inject", tone: "phosphor" };
    case "enforce.attempt":
      return { label: "enforce", tone: "phosphor" };
    case "enforce.validated":
      return { label: "valid", tone: "phosphor" };
    case "enforce.retry":
      return { label: "retry", tone: "warning" };
    case "enforce.empty_response":
      return { label: "empty", tone: "warning" };
    case "enforce.stripped":
      return { label: "strip", tone: "phosphor" };
    case "stream.chunk":
      return { label: "chunk", tone: "muted" };
    default:
      return { label: "event", tone: "muted" };
  }
}

function summarize(event: RequestEvent): string {
  switch (event.type) {
    case "request.started":
      return `${event.protocol} · ${event.model}${event.stream ? " · stream" : ""}${event.enforceEnabled ? " · enforce" : ""}`;
    case "request.finished":
      return `HTTP ${event.status} in ${event.totalMs}ms${event.errorType !== undefined ? " · " + event.errorType : ""}`;
    case "route.attempted":
      return `attempt ${event.attempt} → ${event.provider}/${event.model}${event.isFallback ? " [fallback]" : ""} · key ${event.keyHint}`;
    case "route.succeeded":
      return `${event.provider}/${event.model} ok in ${event.latencyMs}ms`;
    case "route.failed":
      return `${event.provider}/${event.model} ${event.status ?? "?"} · ${event.errorType}${event.willFallback ? " → fallback" : ""}`;
    case "key.cooldown":
      return `${event.provider}/${event.model} · ${event.action}${event.cooldownSeconds !== undefined ? " (" + event.cooldownSeconds + "s)" : ""}`;
    case "autofix.applied":
      return `${event.protocol} tool-response autofix on ${event.provider}/${event.model}`;
    case "enforce.injected":
      return `guidance injected (${event.guidanceLength} chars)`;
    case "enforce.attempt":
      return `enforce attempt ${event.attempt}/${event.maxRetries}`;
    case "enforce.validated":
      return `validated via ${event.kind}`;
    case "enforce.retry":
      return `retry: ${event.reason.slice(0, 80)}`;
    case "enforce.empty_response":
      return `empty response (${event.policy})`;
    case "enforce.stripped":
      return `flag stripped${event.contentBecameNull ? " · content=null" : ""}${event.toolCallsPreserved ? " · tool_calls preserved" : ""}`;
    case "stream.chunk":
      return `chunk #${event.chunkNumber} (${event.bytes}B)`;
    default:
      return "—";
  }
}
