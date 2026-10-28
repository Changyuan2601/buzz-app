// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoControls } from "./VideoPlayer";

const renders = vi.hoisted(() => ({ controls: 0 }));
vi.mock("./use-media-corners", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-media-corners")>();
  return {
    useMediaCorners: () => {
      renders.controls += 1;
      return actual.useMediaCorners();
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("advances the timecode and progress each frame without re-rendering the control bar", () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  let currentTime = 0;
  function Controls() {
    const video = useRef<HTMLVideoElement>(null);
    return (
      <>
        <video ref={video}>
          <track kind="captions" />
        </video>
        <VideoControls videoRef={video} />
      </>
    );
  }
  const view = render(<Controls />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => false },
    duration: { configurable: true, value: 100 },
    currentTime: { configurable: true, get: () => currentTime },
  });
  act(() => {
    video.dispatchEvent(new Event("durationchange"));
    video.dispatchEvent(new Event("play"));
  });
  const progress = screen.getByRole("slider", { name: "Video timeline" });
  expect(progress).toHaveAttribute("aria-valuetext", "00:00 / 01:40");
  const before = renders.controls;
  for (const seconds of [1, 2, 3, 25]) {
    currentTime = seconds;
    act(() => frames.shift()?.(performance.now()));
  }
  expect(renders.controls).toBe(before);
  expect(progress).toHaveAttribute("aria-valuetext", "00:25 / 01:40");
  expect(progress).toHaveValue("25");
  expect(progress.style.getPropertyValue("--progress")).toBe("25%");
  expect(screen.getByText("00:25")).toBeInTheDocument();
});
