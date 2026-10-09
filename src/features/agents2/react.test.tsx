// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAgent2 } from "./react";
import type { Agent, Agents2 } from "./service";

it("still finds a saved agent whose type plugin is not registered", () => {
  const agent = { pubkey: "a".repeat(64), type: "gone/echo" } as Agent;
  const agents2 = {
    subscribe: () => () => {},
    find: (pubkey: string) => (pubkey === agent.pubkey ? agent : undefined),
    types: () => [],
  } as unknown as Agents2;
  const { result } = renderHook(() => useAgent2(agents2, agent.pubkey));
  expect(result.current).toEqual({ agent, type: undefined });
  const other = renderHook(() => useAgent2(agents2, "b".repeat(64)));
  expect(other.result.current).toBeUndefined();
});
