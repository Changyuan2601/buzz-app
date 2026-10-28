// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoControls } from "./VideoPlayer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("ticks playing progress every frame only while the video is on screen", () => {
  let report: IntersectionObserverCallback | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        report = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    frames.length = 0;
  });
  function Controls() {
    const video = useRef<HTMLVideoElement>(null);
    return (
      <>
        {/* biome-ignore lint/a11y/useMediaCaption: test fixture */}
        <video ref={video} />
        <VideoControls videoRef={video} inline />
      </>
    );
  }
  const view = render(<Controls />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  let now = 0;
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => false },
    duration: { configurable: true, value: 100 },
    currentTime: { configurable: true, get: () => now },
  });
  fireEvent.durationChange(video);
  // The elapsed label precedes the duration label.
  const time = () =>
    [...view.container.querySelectorAll("[data-video-controls] span")]
      .map((span) => span.textContent)
      .find((text) => /^\d\d:\d\d$/.test(text ?? ""));
  const visible = (isIntersecting: boolean) =>
    act(() =>
      report?.(
        [{ isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
  fireEvent.play(video);
  expect(frames).toHaveLength(0);
  // Offscreen controls still follow the media element's own time updates.
  now = 3;
  fireEvent.timeUpdate(video);
  expect(time()).toBe("00:03");

  now = 5;
  visible(true);
  expect(time()).toBe("00:05");
  expect(frames).toHaveLength(1);
  now = 7;
  act(() => frames.shift()?.(0));
  expect(time()).toBe("00:07");
  expect(frames).toHaveLength(1);

  visible(false);
  expect(frames).toHaveLength(0);
});
