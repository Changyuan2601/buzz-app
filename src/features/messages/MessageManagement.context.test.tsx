// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import { MessageManagement, useMessageDeletion } from "./MessageManagement";

afterEach(cleanup);

it("keeps management consumers out of channel list updates that change nothing for them", () => {
  let list = { status: "ready", channels: [] };
  const listeners = new Set<() => void>();
  const session = {
    viewer: "a".repeat(64),
    channels: {
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      list: () => list,
    },
  } as unknown as RelaySession;
  let renders = 0;
  function Consumer() {
    renders++;
    useMessageDeletion();
    return null;
  }
  render(
    <MessageManagement session={session} channelId="room">
      <Consumer />
    </MessageManagement>,
  );
  const before = renders;
  act(() => {
    list = { ...list, channels: [] };
    for (const listener of listeners) listener();
  });
  expect(renders).toBe(before);
});
