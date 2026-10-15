import type { BubbleColor } from "../../theme/bubble-color";
import { Radio, RadioGroup } from "./RadioGroup";
import { Field } from "./Field";

export type ThemeMode = "system" | "light" | "dark";

function Preview({
  tone,
  messageColor,
}: {
  tone: "light" | "dark";
  messageColor: BubbleColor;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 80 56"
      className={`buzz-theme-preview ${tone}`}
      data-tone={tone}
      data-bubble-color={messageColor}
    >
      <rect
        width="80"
        height="56"
        rx="8"
        className="buzz-theme-preview-backdrop"
      />
      <rect
        x="5"
        y="5"
        width="70"
        height="46"
        rx="5"
        className="buzz-theme-preview-panel"
      />
      <path d="M23 5v46" className="buzz-theme-preview-divider" />
      <path
        d="M10 13h7M10 18h5M29 17h30M29 22h24M29 27h32"
        className="buzz-theme-preview-lines"
      />
      <rect
        x="45"
        y="10"
        width="23"
        height="5"
        rx="2.5"
        className="buzz-theme-preview-message"
      />
      <rect
        x="49"
        y="32"
        width="19"
        height="5"
        rx="2.5"
        className="buzz-theme-preview-message"
      />
      <rect
        x="29"
        y="41"
        width="39"
        height="6"
        rx="3"
        className="buzz-theme-preview-composer"
      />
    </svg>
  );
}

/** Visual choices retain the shared radio group's keyboard and label behavior. */
export function ThemePicker({
  value,
  onValueChange,
  messageColor = "neutral",
}: {
  value: ThemeMode;
  messageColor?: BubbleColor;
  onValueChange: (value: ThemeMode) => void;
}) {
  return (
    <div data-buzz-ui="" className="buzz-theme-picker">
      <Field label="Color mode" labelVisibility="hidden" nativeLabel={false}>
        <RadioGroup
          aria-label="Color mode"
          value={value}
          onValueChange={onValueChange}
        >
          {(["system", "light", "dark"] as const).map((mode) => (
            <Radio
              key={mode}
              value={mode}
              label={
                <span className="buzz-theme-choice">
                  <span
                    className="buzz-theme-thumbnail"
                    data-mode={mode}
                    aria-hidden="true"
                  >
                    {mode !== "dark" && (
                      <Preview tone="light" messageColor={messageColor} />
                    )}
                    {mode !== "light" && (
                      <Preview tone="dark" messageColor={messageColor} />
                    )}
                  </span>
                  <span className="sr-only">
                    {mode === "system"
                      ? "System"
                      : mode === "light"
                        ? "Light"
                        : "Dark"}
                  </span>
                </span>
              }
            />
          ))}
        </RadioGroup>
      </Field>
    </div>
  );
}
