// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Profiler, useRef, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoControls } from "./VideoPlayer";

const buttons = vi.hoisted(() => ({ renders: 0 }));
vi.mock("../../shared/design-system/ui/Button", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../shared/design-system/ui/Button")
    >();
  return {
    ...actual,
    Button(props: ComponentProps<typeof actual.Button>) {
      buttons.renders++;
      return <actual.Button {...props} />;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Player() {
  const video = useRef<HTMLVideoElement>(null);
  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: test fixture */}
      <video ref={video} />
      <VideoControls videoRef={video} inline />
    </>
  );
}

it("follows playback every frame without re-rendering the other controls", () => {
  let frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  let commits = 0;
  render(
    <Profiler id="player" onRender={() => commits++}>
      <Player />
    </Profiler>,
  );
  const video = document.querySelector("video");
  if (!video) throw new Error("Missing video element");
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  fireEvent.durationChange(video);
  fireEvent.play(video);
  const settled = buttons.renders;
  const frame = (seconds: number) => {
    video.currentTime = seconds;
    act(() => {
      const due = frames;
      frames = [];
      for (const callback of due) callback(performance.now());
    });
  };

  for (const seconds of [12.25, 12.5, 13.75]) frame(seconds);
  // Neither the whole seconds nor the slider's 0.1s steps change here.
  const rendered = commits;
  frame(13.76);
  frame(13.79);
  expect(commits).toBe(rendered);

  const slider = screen.getByRole("slider", { name: "Video progress" });
  expect(slider).toHaveAttribute("aria-valuetext", "00:13 / 01:40");
  expect(screen.getByText("00:13")).toBeInTheDocument();
  expect(buttons.renders).toBe(settled);
});
