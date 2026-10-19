// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  chatOrigin,
  localOriginPreview,
  saveLocalOrigin,
} from "./local-origin-preview";
const origin = {
  channelId: "11111111-1111-4111-8111-111111111111",
  messageId: "a".repeat(64),
};
const channel = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Work",
  creator: "owner",
};
afterEach(() => {
  localStorage.clear();
  vi.unstubAllEnvs();
});
it("keeps local sources partitioned and subordinate to relay metadata, and ignores them outside opted-in development", () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_BUZZ_LOCAL_ORIGIN_PREVIEW", "1");
  saveLocalOrigin("community:owner", channel.id, origin);
  expect(chatOrigin("community:owner", "owner", channel)).toEqual(origin);
  expect(chatOrigin("other:owner", "owner", channel)).toBeUndefined();
  expect(chatOrigin("community:owner", "guest", channel)).toBeUndefined();
  expect(
    chatOrigin("community:owner", "owner", { ...channel, readOnly: true }),
  ).toBeUndefined();
  expect(
    chatOrigin("community:owner", "owner", { ...channel, cached: true }),
  ).toBeUndefined();
  const remote = { ...origin, messageId: "b".repeat(64) };
  expect(
    chatOrigin("community:owner", "owner", { ...channel, origin: remote }),
  ).toEqual(remote);
  vi.stubEnv("VITE_BUZZ_LOCAL_ORIGIN_PREVIEW", "0");
  expect(chatOrigin("community:owner", "owner", channel)).toBeUndefined();
  vi.stubEnv("VITE_BUZZ_LOCAL_ORIGIN_PREVIEW", "1");
  vi.stubEnv("DEV", false);
  expect(localOriginPreview()).toBe(false);
  expect(chatOrigin("community:owner", "owner", channel)).toBeUndefined();
  expect(() => saveLocalOrigin("community:owner", channel.id, origin)).toThrow(
    "disabled",
  );
});
