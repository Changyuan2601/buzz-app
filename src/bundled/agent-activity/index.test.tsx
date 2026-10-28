// @vitest-environment jsdom
import { Context, Service } from "@deepseek-ai/cordis";
import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { expect, it, vi } from "vitest";
import { flush } from "../../features/relay/testing";

const seen = vi.hoisted(() => [] as unknown[]);
vi.mock("./ActivityAccessory", () => ({
  ActivityAccessory: (props: { agents: unknown }) => {
    seen.push(props.agents);
    return null;
  },
  ActivityTypingReplacement: () => null,
}));
import * as plugin from "./index";

class FakeAgents extends Service {
  constructor(ctx: Context) {
    super(ctx, "agents");
  }
  interruptible(agent: string) {
    return agent === "a";
  }
}

it("gives every activity row the same agents service", async () => {
  const root = new Context();
  const accessories: { id: string; component: ComponentType }[] = [];
  root.provide("relay", {
    snapshot: () => ({ status: "idle" }),
    subscribe: () => () => {},
  });
  root.provide("conversation", {
    registerAccessory: (accessory: (typeof accessories)[number]) => {
      accessories.push(accessory);
      return () => {};
    },
  });
  const service = new FakeAgents(root);
  root.plugin(plugin as never);
  await flush();
  const Activity = accessories.find(
    (entry) => entry.id === "activity",
  )?.component;
  if (!Activity) throw new Error("no activity accessory");
  const view = render(<Activity />);
  view.rerender(<Activity />);
  render(<Activity />);
  expect(seen).toHaveLength(3);
  const [agents] = seen as FakeAgents[];
  // Cordis returns a fresh traceable per lookup; rows share one.
  expect(seen.every((value) => value === agents)).toBe(true);
  expect(agents).not.toBe(service);
  expect(agents.interruptible("a")).toBe(true);
  expect(agents.interruptible("b")).toBe(false);
});
