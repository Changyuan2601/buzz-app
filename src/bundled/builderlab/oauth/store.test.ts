import { expect, it, vi } from "vitest";
import type { Credential } from "./browser";
import {
  decodeCredential,
  encodeCredential,
  nativeCredentialStore,
} from "./store";

const credential: Credential = {
  value: "private-token",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
  },
};

it("round-trips a credential through one JSON blob", () => {
  const blob = encodeCredential(credential);
  expect(JSON.parse(blob)).toEqual(credential);
  expect(decodeCredential(blob)).toEqual(credential);
  expect(Object.isFrozen(decodeCredential(blob)?.account)).toBe(true);
});

it.each([
  "",
  "not json",
  "null",
  "[]",
  '{"account":{"subject":"user"}}',
  '{"value":"","account":{"subject":"user"}}',
  '{"value":"a b","account":{"subject":"user"}}',
  `{"value":"${"x".repeat(4097)}","account":{"subject":"user"}}`,
  '{"value":"tok"}',
  '{"value":"tok","account":{"subject":" "}}',
])("treats %j as no saved credential", (blob) => {
  expect(decodeCredential(blob)).toBeUndefined();
});

it("fills in account fields older blobs lack, trusting only an explicit capability", () => {
  expect(
    decodeCredential('{"value":"tok","account":{"subject":"user"}}'),
  ).toEqual({
    value: "tok",
    account: { subject: "user", email: "", canUseRemoteAgents: false },
  });
  expect(
    decodeCredential(
      '{"value":"tok","account":{"subject":"user","canUseRemoteAgents":"true"}}',
    )?.account.canUseRemoteAgents,
  ).toBe(false);
});

it("reads, writes and clears through the native commands", async () => {
  const items = new Map<string, string>();
  const send = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "builderlab_session_read")
        return items.get("item") ?? null;
      if (command === "builderlab_session_replace")
        items.set("item", args?.blob as string);
      if (command === "builderlab_session_clear") items.delete("item");
      return undefined;
    },
  );
  const store = nativeCredentialStore(send as never);
  expect(await store.read()).toBeUndefined();
  await store.write(credential);
  expect(items.get("item")).toBe(encodeCredential(credential));
  expect(await store.read()).toEqual(credential);
  await store.clear();
  expect(items.size).toBe(0);
  expect(send.mock.calls.map(([command]) => command)).toEqual([
    "builderlab_session_read",
    "builderlab_session_replace",
    "builderlab_session_read",
    "builderlab_session_clear",
  ]);
});

it("drops a saved item it cannot read", async () => {
  const send = vi.fn(async (command: string) =>
    command === "builderlab_session_read" ? "{damaged" : undefined,
  );
  expect(await nativeCredentialStore(send as never).read()).toBeUndefined();
  expect(send.mock.calls.map(([command]) => command)).toEqual([
    "builderlab_session_read",
    "builderlab_session_clear",
  ]);
});

it("a native failure is the caller's to handle", async () => {
  const send = vi.fn(async () => {
    throw "The Keychain is unavailable";
  });
  const store = nativeCredentialStore(send as never);
  await expect(store.read()).rejects.toBe("The Keychain is unavailable");
  await expect(store.write(credential)).rejects.toBe(
    "The Keychain is unavailable",
  );
});
