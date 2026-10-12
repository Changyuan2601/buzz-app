import { InstructionExamples } from "./InstructionExamples";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useImperativeHandle,
  type Ref,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useVoiceNoteRecorder } from "../../features/agents/voice/useVoiceNoteRecorder";
import {
  StopFilledIcon,
  CircleNotchIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { AgentInstructionWaveform } from "./AgentInstructionWaveform";
import { Textarea } from "../../shared/design-system/ui/Textarea";

export type InstructionEditingActions = { back(): void; done(): void };

export function AgentInstructions({
  value,
  disabled,
  onChange,
  onBusyChange,
  embedded = false,
  onActiveChange,
  editingRef,
}: {
  editingRef?: Ref<InstructionEditingActions> | undefined;
  embedded?: boolean;
  onActiveChange?: (active: boolean) => void;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  onBusyChange?: ((busy: boolean) => void) | undefined;
}) {
  const windowsDesktop = isTauri() && /Win/i.test(navigator.platform);
  const [mode, setMode] = useState<"text" | "voice" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const view = embedded && !expanded ? "entry" : (mode ?? "choices");
  const root = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  useLayoutEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const content =
      root.current?.querySelector(".agent-instruction-content") ?? root.current;
    const target = content?.querySelector<HTMLElement>(
      "textarea:not(:disabled), button:not(:disabled)",
    );
    (target ?? root.current)?.focus();
  }, [view]);
  useEffect(() => {
    onActiveChange?.(expanded);
  }, [expanded, onActiveChange]);
  const [phase, setPhase] = useState<"idle" | "transcribing" | "drafting">(
    "idle",
  );
  const [suggestion, setSuggestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const recorder = useVoiceNoteRecorder();
  const cancel = () => {
    generation.current++;
    recorder.cancel();
    setPhase("idle");
  };
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (disabled) {
      generation.current++;
      recorder.cancel();
      setPhase("idle");
    }
  }, [disabled, recorder.cancel]);
  const busy = phase !== "idle" || recorder.status !== "idle";
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const draft = async (text: string, ticket: number) => {
    if (ticket !== generation.current) return;
    setPhase("drafting");
    const result = await invoke<string>("agent_instruction_generate", {
      transcript: text,
    });
    if (ticket === generation.current) setSuggestion(result);
  };
  const finish = async () => {
    const ticket = ++generation.current;
    setError(null);
    try {
      const recording = await recorder.stop();
      if (!recording || ticket !== generation.current) return;
      setPhase("transcribing");
      const bytes = new Uint8Array(await recording.file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      if (ticket !== generation.current) return;
      const text = await invoke<string>("agent_instruction_transcribe", {
        audio: btoa(binary),
      });
      if (ticket !== generation.current) return;
      await draft(text, ticket);
    } catch (cause) {
      if (ticket === generation.current) setError(String(cause));
    } finally {
      if (ticket === generation.current) setPhase("idle");
    }
  };
  useImperativeHandle(editingRef, () => ({
    back() {
      cancel();
      setMode(null);
      setExpanded(false);
    },
    done() {
      if (busy) return;
      setMode(null);
      setExpanded(false);
    },
  }));
  const record = () => {
    if (windowsDesktop) return;
    generation.current++;
    setError(null);
    setSuggestion("");
    void recorder.start();
  };
  return (
    <div
      className="space-y-4"
      ref={root}
      tabIndex={-1}
      data-instruction-view={view}
    >
      {!embedded && <div className="text-label">Agent instructions</div>}
      {embedded && !expanded ? (
        <div className="agent-instruction-entry">
          <span className="agent-instruction-entry-copy">
            {value.trim() && <span>{value}</span>}
            {!value.trim() && <InstructionExamples />}
          </span>
          <div className="agent-instruction-edit-action">
            <Button
              variant="primary"
              aria-label="Agent instructions"
              disabled={disabled}
              onClick={() => setExpanded(true)}
            >
              {value.trim() ? "Edit instructions" : "Add instructions"}
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={
            embedded
              ? "agent-instruction-embedded"
              : "agent-instruction-container agent-create-fields"
          }
        >
          <div className="agent-instruction-toolbar">
            {!embedded && mode === "text" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  cancel();
                  setMode(null);
                  if (embedded) setExpanded(false);
                }}
              >
                {embedded ? "Done" : "Back"}
              </Button>
            )}
          </div>
          <div
            className="agent-instruction-content"
            data-mode={mode ?? "choices"}
          >
            {mode === null ? (
              <div className="grid grid-cols-2 gap-3">
                <Button
                  shape="control"
                  disabled={disabled}
                  style={{ minHeight: "7rem" }}
                  onClick={() => setMode("text")}
                >
                  Text
                </Button>
                <Button
                  shape="control"
                  disabled={disabled || windowsDesktop}
                  title={
                    windowsDesktop
                      ? "Voice drafting is not available on Windows."
                      : undefined
                  }
                  style={{ minHeight: "7rem" }}
                  onClick={() => {
                    setError(null);
                    setMode("voice");
                  }}
                >
                  {embedded ? "Audio" : "Voice"}
                </Button>
              </div>
            ) : mode === "text" ? (
              <Field label="Agent instructions" labelVisibility="hidden">
                <Textarea
                  disabled={disabled}
                  rows={4}
                  value={value}
                  placeholder="Describe what I should do…"
                  onChange={(event) => onChange(event.target.value)}
                />
              </Field>
            ) : (
              <div
                className="agent-instruction-voice space-y-4"
                data-results={Boolean(suggestion)}
              >
                {!suggestion && (
                  <p
                    className="text-body-sm text-secondary"
                    style={{
                      visibility:
                        busy && recorder.status !== "recording"
                          ? "hidden"
                          : "visible",
                    }}
                  >
                    Describe what your agent should do.
                  </p>
                )}
                {!isTauri() && (
                  <p className="text-body-sm text-secondary">
                    Local transcription is available in the desktop app.
                  </p>
                )}
                {busy && (
                  <>
                    <div className="agent-instruction-waveform-slot">
                      {recorder.status === "recording" && (
                        <AgentInstructionWaveform levels={recorder.levels} />
                      )}
                    </div>
                    <IconButton
                      aria-label={
                        recorder.status === "recording"
                          ? "Stop recording"
                          : "Preparing instructions"
                      }
                      aria-busy={recorder.status !== "recording"}
                      icon={
                        recorder.status === "recording" ? (
                          <StopFilledIcon size={20} />
                        ) : (
                          <CircleNotchIcon
                            size={20}
                            className="motion-safe:animate-spin"
                          />
                        )
                      }
                      variant="subtle"
                      shape="round"
                      disabled={disabled || recorder.status !== "recording"}
                      onClick={() => void finish()}
                    />
                    <span role="status" className="sr-only">
                      {recorder.status === "recording"
                        ? "Recording"
                        : recorder.status === "requesting"
                          ? "Waiting for microphone"
                          : "Preparing instructions"}
                    </span>
                  </>
                )}
                {(error || recorder.error) && (
                  <p role="alert" className="text-body-sm">
                    {error || recorder.error}
                  </p>
                )}
                {suggestion && (
                  <Field label="Instruction draft" labelVisibility="hidden">
                    <Textarea
                      rows={4}
                      disabled={busy || disabled}
                      value={suggestion}
                      onChange={(event) => setSuggestion(event.target.value)}
                    />
                  </Field>
                )}
                {!busy && (
                  <div className="flex items-center justify-center gap-3">
                    <Button
                      disabled={disabled || !isTauri() || windowsDesktop}
                      onClick={record}
                    >
                      {suggestion || error || recorder.error
                        ? "Re-record"
                        : "Record"}
                    </Button>
                    {suggestion && (
                      <Button
                        disabled={disabled || !suggestion.trim()}
                        onClick={() => {
                          onChange(suggestion);
                          setMode(embedded ? null : "text");
                          if (embedded) setExpanded(false);
                        }}
                      >
                        Use instructions
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
