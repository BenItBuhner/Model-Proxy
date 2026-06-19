"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Panel, PanelBody } from "@/components/ui/panel";
import { getAnalyticsPricing, saveAnalyticsPricing } from "@/lib/endpoints";

const DEFAULT_TEMPLATE = `{
  "default_pricing": {
    "user_cost": {
      "input_per_1m": 0,
      "output_per_1m": 0
    },
    "typical_cost": {
      "input_per_1m": 3,
      "output_per_1m": 15
    }
  }
}`;

export function CostSettingsPanel(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(DEFAULT_TEMPLATE);
  const [message, setMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    getAnalyticsPricing()
      .then((result) => setText(JSON.stringify(result.pricing, null, 2)))
      .catch((err) => setMessage((err as Error).message));
  }, [open]);

  const save = async (): Promise<void> => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      await saveAnalyticsPricing(parsed);
      setMessage("saved");
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        cost settings
      </Button>
    );
  }

  return (
    <Panel
      title="cost settings"
      subtitle="default actual vs typical pricing"
      accent
      toolbar={
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          close
        </Button>
      }
    >
      <PanelBody className="space-y-3">
        <Textarea value={text} onChange={(event) => setText(event.target.value)} className="min-h-[220px]" />
        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void save()}>
            save pricing
          </Button>
          {message !== undefined ? (
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-500">{message}</span>
          ) : null}
        </div>
      </PanelBody>
    </Panel>
  );
}
