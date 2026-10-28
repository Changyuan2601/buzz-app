// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { startTransition } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { useProfileMessage } from "./useProfileMessage";

afterEach(cleanup);
const person = "a".repeat(64);
const viewer = "b".repeat(64);

function mount(session: RelaySession) {
  let renders = 0;
  const hook = renderHook(
    ({ enabled }: { enabled: boolean }) => {
      renders++;
      return useProfileMessage({
        session,
        pubkey: person,
        viewer,
        agent: false,
        enabled,
        onOpened: () => {},
      });
    },
    { initialProps: { enabled: false } },
  );
  return { ...hook, renders: () => renders };
}

it("mounts without re-rendering for a reset", async () => {
  const { rerender, renders } = mount({
    directMessages: { available: true },
  } as unknown as RelaySession);
  // Message rows mount a closed preview per avatar, then render in transitions.
  await act(async () => {
    startTransition(() => rerender({ enabled: false }));
  });
  expect(renders()).toBe(2);
});

it("clears a failed open when the preview closes", async () => {
  const { result, rerender } = mount({
    directMessages: {
      available: true,
      open: vi.fn(async () => {
        throw new Error("Relay refused.");
      }),
    },
  } as unknown as RelaySession);
  rerender({ enabled: true });
  await act(() => result.current.open());
  expect(result.current).toMatchObject({
    opening: false,
    error: "Relay refused.",
  });
  rerender({ enabled: false });
  expect(result.current.error).toBe("");
});
