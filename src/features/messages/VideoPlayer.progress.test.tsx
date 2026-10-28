// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoControls } from "./VideoPlayer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("ticks playing progress every frame only while the controls are visible", () => {
  let shown = false;
  const checkVisibility = vi.fn(() => shown);
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    value: checkVisibility,
  });
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
  const frame = () => act(() => frames.shift()?.(0));
  try {
    fireEvent.play(video);
    now = 3;
    frame();
    expect(checkVisibility).toHaveBeenCalledWith({
      opacityProperty: true,
      visibilityProperty: true,
    });
    expect(time()).toBe("00:00");
    // Hidden controls still follow the media element's own time updates.
    fireEvent.timeUpdate(video);
    expect(time()).toBe("00:03");

    shown = true;
    now = 5;
    frame();
    expect(time()).toBe("00:05");
    expect(frames).toHaveLength(1);
  } finally {
    delete (HTMLElement.prototype as Partial<HTMLElement>).checkVisibility;
  }
});
