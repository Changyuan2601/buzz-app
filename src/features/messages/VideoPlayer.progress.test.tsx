// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoControls } from "./VideoPlayer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

// The range must keep native input/focus and accessible time in sync even between
// media timeupdate events. Real React lifecycles run under a controlled frame clock.
it("tracks already-playing media, final pause/ended times and remounted playback", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockReturnValue(false);
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(90);
  function Player({ controls = true }: { controls?: boolean }) {
    const video = useRef<HTMLVideoElement>(null);
    return (
      <>
        <video ref={video}>
          <track kind="captions" />
        </video>
        {controls && <VideoControls videoRef={video} inline />}
      </>
    );
  }
  const view = render(<Player />, { wrapper: StrictMode });
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  const progress = screen.getByRole("slider", { name: "Video progress" });
  progress.focus();
  const frame = (time: number) => {
    video.currentTime = time;
    act(() => vi.advanceTimersToNextFrame());
  };
  frame(12.3);
  expect(progress).toHaveValue("12.3");
  expect(progress).toHaveAttribute("aria-valuetext", "00:12 / 01:30");
  expect(screen.getByText("00:12")).toBeVisible();
  expect(progress).toHaveFocus();

  video.currentTime = 14;
  fireEvent.pause(video);
  expect(progress).toHaveValue("14");
  frame(15);
  expect(progress).toHaveValue("14");
  fireEvent.seeked(video);
  expect(progress).toHaveValue("15");
  fireEvent.play(video);
  frame(20);
  expect(progress).toHaveValue("20");
  video.currentTime = 90;
  fireEvent.ended(video);
  expect(progress).toHaveValue("90");
  expect(progress).toHaveAttribute("aria-valuetext", "01:30 / 01:30");
  frame(1);
  expect(progress).toHaveValue("90");

  fireEvent.play(video);
  view.rerender(<Player controls={false} />);
  frame(22);
  view.rerender(<Player />);
  const restored = screen.getByRole("slider", { name: "Video progress" });
  expect(restored).toHaveValue("22");
  frame(25);
  expect(restored).toHaveValue("25");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
