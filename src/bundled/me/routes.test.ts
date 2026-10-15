import { expect, it } from "vitest";
import {
  isMeRoute,
  meAgent,
  meAgentTarget,
  meSection,
  meSelection,
} from "./routes";

const scope = `https://relay.test:${"c".repeat(64)}`;

it("opens a new conversation with the agent its route names", () => {
  const agent = "a".repeat(64);
  const target = meAgentTarget(scope, agent);
  expect(target).toMatchObject({
    kind: "page",
    pluginId: "buzz.me",
    route: { params: `agent:${agent}` },
  });
  expect(meSelection(target)).toBe("new");
  expect(meSection(target)).toBeUndefined();
  expect(meAgent(target)).toBe(agent);
});

it("accepts only a full lowercase agent key", () => {
  for (const params of [
    "agent:",
    `agent:${"a".repeat(63)}`,
    `agent:${"A".repeat(64)}`,
    `agent:${"a".repeat(65)}`,
  ])
    expect(isMeRoute(params)).toBe(false);
  expect(() => meAgentTarget(scope, "nope")).toThrow(
    "Invalid Solo destination",
  );
  expect(meAgent(undefined)).toBeUndefined();
});
