import { Slider as BaseSlider } from "@base-ui/react/slider";
import type { CSSProperties } from "react";

export type SliderStep = { readonly value: string; readonly label: string };

type StepSliderProps = {
  steps: readonly SliderStep[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
} & (
  | { "aria-label": string; "aria-labelledby"?: never }
  | { "aria-labelledby": string; "aria-label"?: never }
);

/**
 * A choice among a few ordered steps, drawn as visible stops on a track.
 * Base UI owns dragging, snapping and keyboard steps; the thumb announces the
 * step's name rather than its position, and the name follows it underneath.
 */
export function StepSlider({
  steps,
  value,
  onValueChange,
  disabled = false,
  ...label
}: StepSliderProps) {
  const last = Math.max(steps.length - 1, 1);
  const index = Math.max(
    0,
    steps.findIndex((step) => step.value === value),
  );
  const at = (position: number) => `${(position / last) * 100}%`;
  return (
    <BaseSlider.Root
      data-buzz-ui=""
      className="buzz-step-slider"
      value={index}
      min={0}
      max={last}
      step={1}
      disabled={disabled}
      onValueChange={(next) => {
        const step = steps[next];
        if (step && step.value !== value) onValueChange(step.value);
      }}
    >
      <BaseSlider.Control className="buzz-step-slider-control">
        <BaseSlider.Track className="buzz-step-slider-track">
          <BaseSlider.Indicator className="buzz-step-slider-indicator" />
          {steps.map((step, position) => (
            <span
              key={step.value}
              aria-hidden="true"
              className="buzz-step-slider-stop"
              data-filled={position <= index || undefined}
              style={{ "--stop-position": at(position) } as CSSProperties}
            />
          ))}
          <BaseSlider.Thumb
            {...label}
            className="buzz-step-slider-thumb"
            getAriaValueText={(_formatted, position) =>
              steps[position]?.label ?? ""
            }
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
      {/* The thumb announces the name; this is its visible echo. */}
      <span
        aria-hidden="true"
        className="buzz-step-slider-label"
        style={{ "--step-position": at(index) } as CSSProperties}
      >
        {steps[index]?.label}
      </span>
    </BaseSlider.Root>
  );
}
