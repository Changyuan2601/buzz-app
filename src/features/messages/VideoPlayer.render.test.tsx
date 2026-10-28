// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoControls } from "./VideoPlayer";

const counts = vi.hoisted(() => ({ menu: 0, popover: 0 }));
vi.mock("../../shared/design-system/ui/Menu", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../shared/design-system/ui/Menu")>();
  return {
    ...actual,
    MenuRoot(props: ComponentProps<typeof actual.MenuRoot>) {
      counts.menu++;
      return <actual.MenuRoot {...props} />;
    },
  };
});
vi.mock("../../shared/design-system/ui/Popover", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../shared/design-system/ui/Popover")
    >();
  return {
    ...actual,
    PopoverRoot(props: ComponentProps<typeof actual.PopoverRoot>) {
      counts.popover++;
      return <actual.PopoverRoot {...props} />;
    },
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("keeps playback time updates out of the volume and speed menus", () => {
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
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  act(() => {
    fireEvent(video, new Event("durationchange"));
  });
  const menu = counts.menu;
  const popover = counts.popover;
  for (const seconds of [1, 2, 3]) {
    video.currentTime = seconds;
    act(() => {
      fireEvent(video, new Event("timeupdate"));
    });
  }
  expect(view.getByRole("slider", { name: "Video timeline" })).toHaveProperty(
    "value",
    "3",
  );
  expect(counts.menu).toBe(menu);
  expect(counts.popover).toBe(popover);
  video.playbackRate = 1.5;
  act(() => {
    fireEvent(video, new Event("ratechange"));
  });
  expect(counts.menu).toBe(menu + 1);
});
