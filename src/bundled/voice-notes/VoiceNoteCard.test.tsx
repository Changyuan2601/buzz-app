// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mediaUrl = `https://relay.test/media/${"a".repeat(64)}.mp4`;
const source = `buzz-media://localhost/${encodeURIComponent(mediaUrl)}`;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(invoke).mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("waits for the native media listener and uses its cancellable stream", async () => {
  let resolve!: (base: string) => void;
  vi.mocked(invoke).mockReturnValue(
    new Promise<string>((ready) => {
      resolve = ready;
    }),
  );
  const { VoiceNoteCard } = await import("./VoiceNoteCard");
  const { container } = render(<VoiceNoteCard source={source} duration={3} />);
  expect(
    screen.getByRole("button", { name: "Play voice note" }),
  ).toBeDisabled();
  expect(container.querySelector("audio")).not.toHaveAttribute("src");
  resolve("http://127.0.0.1:4321/token/");
  await waitFor(() =>
    expect(container.querySelector("audio")).toHaveAttribute(
      "src",
      `http://127.0.0.1:4321/token/${encodeURIComponent(mediaUrl)}`,
    ),
  );
  expect(screen.getByRole("button", { name: "Play voice note" })).toBeEnabled();
});

it("keeps an unavailable uploaded draft removable without falling back to buzz-media", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  const { VoiceNoteCard } = await import("./VoiceNoteCard");
  const onRemove = vi.fn();
  const { container } = render(
    <VoiceNoteCard source={source} duration={3} onRemove={onRemove} />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Audio unavailable",
  );
  expect(container.querySelector("audio")).not.toHaveAttribute("src");
  expect(
    screen.getByRole("button", { name: "Play voice note" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Remove voice note" }));
  expect(onRemove).toHaveBeenCalledOnce();
});
