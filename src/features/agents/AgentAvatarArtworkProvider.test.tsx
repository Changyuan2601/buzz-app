// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { agentAvatars } from "./avatar-packs";
import { AgentAvatarArtworkProvider } from "./AgentAvatarArtworkProvider";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("animates recognized pack portraits across avatar sizes, retaining still fallback and ordinary images", () => {
  const pack = agentAvatars[0];
  if (!pack) throw new Error("Missing avatar fixture");
  const view = render(
    <AgentAvatarArtworkProvider>
      <Avatar
        src={pack.url}
        alt="Agent in sidebar"
        fallback="Agent"
        size="small"
      />
      <Avatar
        src={pack.preview}
        alt="Agent in profile"
        fallback="Agent"
        size="large"
      />
      <Avatar
        src="https://example.test/person.png"
        alt="Person"
        fallback="Person"
      />
    </AgentAvatarArtworkProvider>,
  );
  const sidebar = view.getByRole("img", { name: "Agent in sidebar" });
  const profile = view.getByRole("img", { name: "Agent in profile" });
  const video = sidebar.querySelector("video");
  expect(video).not.toBeNull();
  expect(profile.querySelector("video")).not.toBeNull();
  expect(
    view.getByRole("img", { name: "Person" }).querySelector("video"),
  ).toBeNull();
  fireEvent.error(video as HTMLVideoElement);
  expect(sidebar.querySelector("video")).toBeNull();
  expect(sidebar.querySelector("img")).toHaveAttribute("src", pack.preview);
  expect(sidebar.querySelector("img")).toHaveAttribute("data-loaded", "true");
});

it("starts pack playback only when visible and pauses it when it leaves the viewport", () => {
  let visibility!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        visibility = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const pack = agentAvatars[0];
  if (!pack) throw new Error("Missing avatar fixture");
  const view = render(
    <AgentAvatarArtworkProvider>
      <Avatar src={pack.url} alt="Agent" fallback="Agent" />
    </AgentAvatarArtworkProvider>,
  );
  const video = view.container.querySelector("video");
  expect(video).toHaveAttribute("preload", "none");
  fireEvent.canPlay(video as HTMLVideoElement);
  expect(play).not.toHaveBeenCalled();
  const update = (isIntersecting: boolean) =>
    visibility(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  update(true);
  expect(play).toHaveBeenCalledOnce();
  update(false);
  expect(pause).toHaveBeenCalledOnce();
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
