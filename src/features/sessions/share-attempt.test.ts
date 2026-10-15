import { expect, it } from "vitest";
import {
  beginSessionShare,
  finishSessionShare,
  sessionShareAttempt,
} from "./share-attempt";
import type { RelaySession } from "../relay/session";

it("retains exact submitted intent across view remounts, never rebinding to another selection", () => {
  const session = {} as RelaySession;
  const original = {
    destination: "channel-a",
    sessionPeople: ["person-b"],
  };
  const attempt = beginSessionShare(session, "work", original);
  attempt.messageId = "operation";
  attempt.audienceKeys = ["person-b", "person-c"];
  expect(
    beginSessionShare(session, "work", {
      destination: "channel-b",
      sessionPeople: [],
    }),
  ).toBe(attempt);
  expect(sessionShareAttempt(session, "work")).toMatchObject({
    intent: original,
    audienceKeys: ["person-b", "person-c"],
    messageId: "operation",
  });
  finishSessionShare(session, "work");
  expect(sessionShareAttempt(session, "work")).toBeUndefined();
  expect(sessionShareAttempt({} as RelaySession, "work")).toBeUndefined();
});
