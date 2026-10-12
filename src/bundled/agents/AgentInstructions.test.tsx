// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createRef, StrictMode } from "react";
import { Blob, File } from "node:buffer";
import type { InstructionEditingActions } from "./AgentInstructions";
import { AgentInstructions } from "./AgentInstructions";
const tracks = { stop: vi.fn() };
const getUserMedia = vi.fn();
const decodeAudio = vi.fn();
const closeAudio = vi.fn(async () => {});
class BrowserRecorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  state = "inactive";
  mimeType = "audio/webm";
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.dispatchEvent(
        Object.assign(new Event("dataavailable"), {
          data: new Blob([new Uint8Array([1, 2, 3])]),
        }),
      );
      this.dispatchEvent(new Event("stop"));
    });
  }
}
class BrowserAudioContext {
  close = closeAudio;
  createAnalyser() {
    return {
      fftSize: 512,
      smoothingTimeConstant: 0,
      getByteTimeDomainData: (samples: Uint8Array) => samples.fill(128),
    };
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  decodeAudioData = decodeAudio;
}
beforeEach(() => {
  vi.stubGlobal("MediaRecorder", BrowserRecorder);
  vi.stubGlobal("AudioContext", BrowserAudioContext);
  vi.stubGlobal("Blob", Blob);
  vi.stubGlobal("File", File);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia },
  });
  closeAudio.mockResolvedValue(undefined);
  decodeAudio.mockResolvedValue({
    numberOfChannels: 1,
    sampleRate: 16_000,
    duration: 1,
    getChannelData: () => new Float32Array([0, 0.5, -0.5]),
  });
  getUserMedia.mockResolvedValue({ getTracks: () => [tracks] });
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  const onChange = vi.fn();
  render(
    <StrictMode>
      <AgentInstructions
        value="Existing instructions"
        disabled={false}
        onChange={onChange}
      />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  await startRecording();
  return onChange;
}
async function startRecording() {
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  await screen.findByRole("button", { name: "Stop recording" });
}
it("transcribes locally, sends only text for drafting, and requires explicit apply", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce("Help me plan trips")
    .mockResolvedValueOnce("Plan trips for the user.");
  const onChange = await setup();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Instruction draft")).toHaveValue(
      "Plan trips for the user.",
    ),
  );
  expect(invoke).toHaveBeenNthCalledWith(1, "agent_instruction_transcribe", {
    audio: expect.any(String),
  });
  expect(invoke).toHaveBeenNthCalledWith(2, "agent_instruction_generate", {
    transcript: "Help me plan trips",
  });
  expect(onChange).not.toHaveBeenCalled();
  expect(tracks.stop).toHaveBeenCalledTimes(1);
  expect(closeAudio).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("Instruction draft"), {
    target: { value: "Plan short trips." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use instructions" }));
  expect(onChange).toHaveBeenCalledWith("Plan short trips.");
});
it("shows a re-record action after failure and ignores results after unmount", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce("Be a travel helper")
    .mockRejectedValueOnce("Model unavailable");
  await setup();
  expect(
    screen.queryByRole("button", { name: "Back" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Model unavailable"),
  );
  expect(screen.queryByLabelText("Transcript")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Re-record" }));
  await screen.findByRole("button", { name: "Stop recording" });
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  cleanup();
  vi.clearAllMocks();
  let resolve!: (value: string) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }) as ReturnType<typeof invoke>,
  );
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  cleanup();
  await act(async () => resolve("Cancelled speech"));
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("offers choices and retains text when returning to them", () => {
  render(
    <StrictMode>
      <AgentInstructions
        value="Keep this draft"
        disabled={false}
        onChange={vi.fn()}
      />
    </StrictMode>,
  );
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Text" }));
  expect(screen.getByLabelText("Agent instructions")).toHaveValue(
    "Keep this draft",
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
});

it("closing embedded editing preserves existing instructions until explicit apply", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce("New description")
    .mockResolvedValueOnce("New generated instructions");
  const editingRef = createRef<InstructionEditingActions>();
  const onChange = vi.fn();
  render(
    <StrictMode>
      <AgentInstructions
        embedded
        editingRef={editingRef}
        value="Existing cloned instructions"
        disabled={false}
        onChange={onChange}
      />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Agent instructions" }));
  fireEvent.click(screen.getByRole("button", { name: "Audio" }));
  await startRecording();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Instruction draft")).toHaveValue(
      "New generated instructions",
    ),
  );
  act(() => editingRef.current?.done());
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByText("Existing cloned instructions")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Agent instructions" }));
  fireEvent.click(screen.getByRole("button", { name: "Audio" }));
  fireEvent.click(screen.getByRole("button", { name: "Use instructions" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(
    "New generated instructions",
  );
});

it("releases a microphone permission result arriving after unmount", async () => {
  let grant!: (stream: unknown) => void;
  getUserMedia.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  render(
    <StrictMode>
      <AgentInstructions value="" disabled={false} onChange={vi.fn()} />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  fireEvent.click(screen.getByRole("button", { name: "Record" }));
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  cleanup();
  await act(async () => grant({ getTracks: () => [tracks] }));
  expect(tracks.stop).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
});

it("cancels pending audio processing on unmount without transcribing", async () => {
  let decoded!: (audio: unknown) => void;
  decodeAudio.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        decoded = resolve;
      }),
  );
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() => expect(decodeAudio).toHaveBeenCalledTimes(1));
  expect(tracks.stop).toHaveBeenCalledTimes(1);
  expect(closeAudio).not.toHaveBeenCalled();
  cleanup();
  expect(tracks.stop).toHaveBeenCalledTimes(1);
  expect(closeAudio).toHaveBeenCalledTimes(1);
  await act(async () =>
    decoded({
      numberOfChannels: 1,
      sampleRate: 16_000,
      duration: 1,
      getChannelData: () => new Float32Array([0]),
    }),
  );
  expect(invoke).not.toHaveBeenCalled();
  expect(tracks.stop).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "disables Windows voice before microphone access (embedded=%s)",
  (embedded) => {
    vi.stubGlobal("navigator", {
      platform: "Win32",
      mediaDevices: { getUserMedia },
    });
    render(
      <StrictMode>
        <AgentInstructions
          embedded={embedded}
          value="Keep text"
          disabled={false}
          onChange={vi.fn()}
        />
      </StrictMode>,
    );
    if (embedded)
      fireEvent.click(
        screen.getByRole("button", { name: "Agent instructions" }),
      );
    const voice = screen.getByRole("button", {
      name: embedded ? "Audio" : "Voice",
    });
    expect(voice).toBeDisabled();
    fireEvent.click(voice);
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(screen.getByLabelText("Agent instructions")).toHaveValue(
      "Keep text",
    );
  },
);
