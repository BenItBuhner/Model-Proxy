"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { newToolId, type ToolDefinition } from "@/lib/test-session";

interface ToolsProps {
  tools: ToolDefinition[];
  onChange: (tools: ToolDefinition[]) => void;
}

export function ToolsPanel(props: ToolsProps): React.ReactElement {
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  function addTool(): void {
    const id = newToolId();
    props.onChange([
      ...props.tools,
      {
        id,
        name: "my_tool",
        description: "",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ]);
    setExpanded(id);
  }

  function updateTool(id: string, patch: Partial<ToolDefinition>): void {
    props.onChange(
      props.tools.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }

  function removeTool(id: string): void {
    props.onChange(props.tools.filter((t) => t.id !== id));
  }

  return (
    <div className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
          Tools sent with the request ({props.tools.length})
        </div>
        <Button variant="outline" size="sm" onClick={addTool}>
          + add tool
        </Button>
      </div>
      {props.tools.length === 0 ? (
        <div className="py-8 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-bone-300">
          no tools defined
        </div>
      ) : null}
      {props.tools.map((tool) => {
        const isOpen = expanded === tool.id;
        return (
          <div key={tool.id} className="bg-ink-700 shadow-edge">
            <button
              onClick={() => setExpanded(isOpen ? undefined : tool.id)}
              className="flex w-full items-center justify-between px-3 py-2 text-left"
            >
              <span className="font-mono text-[12px] text-bone-900">
                {tool.name}
              </span>
              <span className="flex items-center gap-2">
                <Badge tone="muted">
                  {Object.keys(
                    (tool.parameters as { properties?: Record<string, unknown> })[
                      "properties"
                    ] ?? {},
                  ).length}{" "}
                  args
                </Badge>
                <span className="font-mono text-[10px] text-bone-300">
                  {isOpen ? "▼" : "▶"}
                </span>
              </span>
            </button>
            {isOpen ? (
              <div className="space-y-3 border-t border-ink-500 px-3 py-3">
                <div>
                  <Label>name</Label>
                  <Input
                    monospace
                    value={tool.name}
                    onChange={(e) =>
                      updateTool(tool.id, { name: e.target.value.replace(/\s+/g, "_") })
                    }
                  />
                </div>
                <div>
                  <Label>description</Label>
                  <Input
                    value={tool.description}
                    onChange={(e) =>
                      updateTool(tool.id, { description: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label hint="JSON Schema (object)">parameters</Label>
                  <textarea
                    rows={7}
                    value={JSON.stringify(tool.parameters, null, 2)}
                    onChange={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value) as Record<
                          string,
                          unknown
                        >;
                        updateTool(tool.id, { parameters: parsed });
                      } catch {
                        // leave alone — user is mid-edit
                      }
                    }}
                    className="w-full bg-ink-800 px-3 py-2 text-[12px] leading-6 text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none font-mono"
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => removeTool(tool.id)}
                  >
                    remove
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
