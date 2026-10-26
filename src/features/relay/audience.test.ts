import { expect, it } from "vitest";
import { detailsBrief, messageAudience } from "./audience";

const event = (...tags: string[][]) =>
  ({ tags }) as unknown as Parameters<typeof messageAudience>[0];

it("reads agents and details audiences; anything else is for everyone", () => {
  expect(messageAudience(event(["audience", "agents"]))).toBe("agents");
  expect(messageAudience(event(["audience", "details"]))).toBe("details");
  expect(messageAudience(event(["audience", "everyone"]))).toBeUndefined();
  expect(messageAudience(event(["audience", "detail"]))).toBeUndefined();
  expect(messageAudience(event())).toBeUndefined();
});

it("briefs details as their first paragraph, after a leading heading", () => {
  expect(detailsBrief("\nThe brief.\n\nHidden.\n\nAlso hidden.")).toBe(
    "The brief.",
  );
  expect(detailsBrief("# Title\n\nThe brief.\n\nHidden.")).toBe(
    "# Title\n\nThe brief.",
  );
  expect(detailsBrief("Only a brief.")).toBe("Only a brief.");
});
