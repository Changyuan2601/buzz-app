import { expect, it } from "vitest";
import {
  beginSoloShare,
  finishSoloShare,
  soloShareAttempt,
} from "./share-attempt";
import type { RelaySession } from "../relay/session";

it("retains exact submitted intent across view remounts, never rebinding to another selection", () => {
  const session = {} as RelaySession;
  const original = {
    destination: "channel-a",
    chatPeople: ["person-b"],
  };
  const attempt = beginSoloShare(session, "work", original);
  attempt.messageId = "operation";
  attempt.audienceKeys = ["person-b", "person-c"];
  expect(
    beginSoloShare(session, "work", {
      destination: "channel-b",
      chatPeople: [],
    }),
  ).toBe(attempt);
  expect(soloShareAttempt(session, "work")).toMatchObject({
    intent: original,
    audienceKeys: ["person-b", "person-c"],
    messageId: "operation",
  });
  finishSoloShare(session, "work");
  expect(soloShareAttempt(session, "work")).toBeUndefined();
  expect(soloShareAttempt({} as RelaySession, "work")).toBeUndefined();
});
