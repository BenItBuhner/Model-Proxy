"use client";

export function MetricWidget({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel?: string;
}): React.ReactElement {
  return (
    <div className="corners bg-ink-800 px-5 py-5 shadow-edge">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
        {label}
      </div>
      <div className="mt-3 font-mono text-[28px] leading-none text-bone-900">
        {value}
      </div>
      {sublabel !== undefined ? (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-500">
          {sublabel}
        </div>
      ) : null}
    </div>
  );
}
