"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { OrbCanvas } from "@/components/OrbCanvas";
import type { OrbSpec } from "@/lib/types";

type Props = {
  spec: OrbSpec;
  /** Path to the source image this orb is recreating. */
  reference: string;
};

/**
 * Query params (used by scripts/capture.mjs, handy by hand too):
 *   ?bare=1      strip all chrome, canvas fills the viewport
 *   ?freeze=6    render a single deterministic frame at t=6s
 *   ?count=20000 override particle count
 *   ?energy=0.9  override amplitude, i.e. how loudly EVE is talking
 *   ?erupt=1.4   override eruption strength (the flow slider)
 */
export function OrbView({ spec, reference }: Props) {
  const params = useSearchParams();

  const bare = params.get("bare") === "1";
  const freezeParam = params.get("freeze");
  const freeze = freezeParam === null ? undefined : Number(freezeParam);
  const countParam = Number(params.get("count"));
  const initialCount =
    Number.isFinite(countParam) && countParam > 0 ? Math.floor(countParam) : spec.defaultCount;

  const [count, setCount] = useState(initialCount);
  const [flow, setFlow] = useState(numberParam(params.get("erupt"), 1));
  // orb1 wants many tiny motes so the body reads as matte dust; orb2 wants few
  // large ones so the halftone lattice stays individually resolvable. A spec
  // that solves its own point size from coverage ignores this entirely.
  const [size, setSize] = useState(spec.id === "orb1" ? 0.0044 : 0.0115);
  const [energy, setEnergy] = useState(numberParam(params.get("energy"), 0.5));
  const [compare, setCompare] = useState(false);

  if (bare) {
    return (
      <OrbCanvas
        className="stage stage--bare"
        spec={spec}
        count={count}
        flow={flow}
        size={size}
        energy={energy}
        freeze={Number.isFinite(freeze) ? freeze : undefined}
      />
    );
  }

  return (
    <main className="view">
      <header className="view__bar">
        <Link href="/" className="view__back">
          ← both orbs
        </Link>
        <div>
          <h1 className="view__title">{spec.label}</h1>
          <p className="view__note">{spec.note}</p>
        </div>
        <button type="button" className="btn" aria-pressed={compare} onClick={() => setCompare((v) => !v)}>
          {compare ? "Hide reference" : "Show reference"}
        </button>
      </header>

      <div className={compare ? "split split--open" : "split"}>
        <OrbCanvas
          className="stage"
          spec={spec}
          count={count}
          flow={flow}
          size={size}
          energy={energy}
          freeze={Number.isFinite(freeze) ? freeze : undefined}
        />
        {compare ? (
          <figure className="stage stage--ref">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={reference} alt={`Reference image for ${spec.label}`} />
            <figcaption>reference</figcaption>
          </figure>
        ) : null}
      </div>

      <div className="controls">
        <Slider
          label="particles"
          value={count}
          min={2000}
          max={200000}
          step={2000}
          onChange={setCount}
          format={(v) => v.toLocaleString()}
        />
        <Slider label="mote size" value={size} min={0.001} max={0.02} step={0.0002} onChange={setSize} />
        <Slider label="flow" value={flow} min={0} max={3} step={0.05} onChange={setFlow} />
        <Slider label="energy" value={energy} min={0} max={1} step={0.01} onChange={setEnergy} />
      </div>
    </main>
  );
}

/** A query-param number, falling back when absent or unparseable. */
function numberParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
};

function Slider({ label, value, min, max, step, onChange, format }: SliderProps) {
  return (
    <label className="control">
      <span className="control__label">
        {label}
        <b>{format ? format(value) : value.toFixed(4)}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
