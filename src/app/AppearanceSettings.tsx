import {
  ACCENTS,
  COLOR_LEVELS,
  accentButtonStyle,
  type ColorLevel,
} from "../shared/theme/accent";
import { StepSlider } from "../shared/design-system/ui/StepSlider";
import { IconButton } from "../shared/design-system/ui/IconButton";
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
} from "../shared/design-system/icons";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { ThemePicker } from "../shared/design-system/ui/ThemePicker";
import { Button } from "../shared/design-system/ui/Button";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Appearance } from "../shared/theme/service";

const COLOR_LEVEL_LABELS: Record<ColorLevel, string> = {
  neutral: "Snoozin’",
  touch: "Hummin’",
  more: "Swarmin’",
  full: "Buzzin’",
};
const COLOR_LEVEL_STEPS = COLOR_LEVELS.map((level) => ({
  value: level,
  label: COLOR_LEVEL_LABELS[level],
}));

export function AppearanceSettings({
  appearance,
  active = true,
}: {
  appearance: Appearance;
  active?: boolean;
}) {
  const increaseButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<HTMLButtonElement | null>(null);
  const resetRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    return () => {
      if (document.activeElement === node)
        pendingFocus.current = increaseButton.current;
    };
  }, []);
  useLayoutEffect(() => {
    // At 200%, Increase is still disabled during Reset's ref cleanup.
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.isConnected) target.focus();
  });
  const {
    preference,
    mode,
    error,
    fontScale,
    fontError,
    accent,
    accentError,
    colorLevel,
    colorLevelError,
  } = useSyncExternalStore(appearance.subscribe, appearance.snapshot);
  return (
    <section aria-labelledby="appearance-settings-title">
      <Header id="appearance-settings-title" title="Appearance" />
      <div>
        <SettingsGroup>
          <PreferenceRow
            title="Color mode"
            trailing={
              <ThemePicker
                value={preference}
                onValueChange={appearance.setMode}
              />
            }
          />
          <PreferenceRow
            title="Interface size"
            trailing={
              <fieldset
                aria-label="Interface size"
                className="m-0 flex min-w-0 flex-wrap items-center gap-3 border-0 p-0"
              >
                <Button
                  type="button"
                  size="sm"
                  aria-label="Decrease interface size"
                  disabled={fontScale <= 0.8}
                  onClick={() => appearance.setFontScale(fontScale - 0.1)}
                >
                  −
                </Button>
                <output
                  aria-label="Interface size"
                  className="text-body-sm tabular-nums"
                >
                  {Math.round(fontScale * 100)}%
                </output>
                <Button
                  type="button"
                  size="sm"
                  ref={increaseButton}
                  aria-label="Increase interface size"
                  disabled={fontScale >= 2}
                  onClick={() => appearance.setFontScale(fontScale + 0.1)}
                >
                  +
                </Button>
                {fontScale !== 1 && (
                  <IconButton
                    icon={<ArrowCounterClockwiseIcon aria-hidden="true" />}
                    title="Reset interface size"
                    size="sm"
                    type="button"
                    ref={resetRef}
                    aria-label="Reset interface size"
                    onClick={() => appearance.setFontScale(1)}
                  />
                )}
              </fieldset>
            }
          />
          <PreferenceRow
            title="Accent color"
            trailing={(label) => (
              <fieldset
                {...label}
                className="m-0 min-w-0 max-w-full border-0 p-0"
              >
                <div
                  data-accent-colors
                  className="grid auto-cols-max grid-flow-col gap-2 overflow-x-auto p-1 scroll-p-1 [&>button]:scroll-m-1"
                >
                  {ACCENTS.map((color) => {
                    const colorLabel = `${color.charAt(0).toUpperCase()}${color.slice(1)}`;
                    return (
                      <IconButton
                        key={color}
                        data-accent={color}
                        data-color-mode={mode}
                        style={accentButtonStyle}
                        variant="primary"
                        size="sm"
                        shape="round"
                        aria-label={`${colorLabel} accent color`}
                        title={colorLabel}
                        aria-pressed={accent === color}
                        onFocus={(event) =>
                          event.currentTarget.scrollIntoView({
                            block: "nearest",
                            inline: "nearest",
                          })
                        }
                        onClick={() => appearance.setAccent(color)}
                        icon={
                          <CheckIcon
                            aria-hidden="true"
                            className={
                              accent === color ? "opacity-100" : "opacity-0"
                            }
                          />
                        }
                      />
                    );
                  })}
                </div>
              </fieldset>
            )}
          />
          <PreferenceRow
            title="Vibe level"
            trailing={(label) => (
              <StepSlider
                aria-labelledby={label["aria-labelledby"]}
                steps={COLOR_LEVEL_STEPS}
                value={colorLevel}
                onValueChange={(value) =>
                  appearance.setColorLevel(value as ColorLevel)
                }
              />
            )}
          />
        </SettingsGroup>
        {active && accentError && (
          <ToastNotice
            title="Accent color wasn’t saved"
            description={accentError}
          >
            <Button size="sm" onClick={() => appearance.setAccent(accent)}>
              Retry saving accent color
            </Button>
          </ToastNotice>
        )}
        {active && colorLevelError && (
          <ToastNotice
            title="Vibe level wasn’t saved"
            description={colorLevelError}
          >
            <Button
              size="sm"
              onClick={() => appearance.setColorLevel(colorLevel)}
            >
              Retry saving vibe level
            </Button>
          </ToastNotice>
        )}
        {active && fontError && (
          <ToastNotice
            title="Interface size wasn’t saved"
            description={fontError}
          >
            <Button
              type="button"
              size="sm"
              onClick={() => appearance.setFontScale(fontScale)}
            >
              Retry saving interface size
            </Button>
          </ToastNotice>
        )}
        {active && error && (
          <ToastNotice title="Appearance wasn’t saved" description={error}>
            <Button
              type="button"
              size="sm"
              onClick={() => appearance.setMode(preference)}
            >
              Retry saving appearance
            </Button>
          </ToastNotice>
        )}
      </div>
    </section>
  );
}
