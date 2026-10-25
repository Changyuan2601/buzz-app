import { expect, it } from "vitest";
import { messageAudience } from "./audience";

const event = (...tags: string[][]) =>
  ({ tags }) as unknown as Parameters<typeof messageAudience>[0];

it("reads agents and details audiences; anything else is for everyone", () => {
  expect(messageAudience(event(["audience", "agents"]))).toBe("agents");
  expect(messageAudience(event(["audience", "details"]))).toBe("details");
  expect(messageAudience(event(["audience", "everyone"]))).toBeUndefined();
  expect(messageAudience(event(["audience", "detail"]))).toBeUndefined();
  expect(messageAudience(event())).toBeUndefined();
});
