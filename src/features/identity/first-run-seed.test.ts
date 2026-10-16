import { describe, expect, it } from "vitest";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { seededAccount } from "./builderlab-account";
import { parseFirstRunAccountSeed } from "./first-run-seed";

const pubkey = "ab".repeat(32);

describe("parseFirstRunAccountSeed", () => {
  it("is absent when unset, and `unlinked` answers no key and no communities", async () => {
    expect(parseFirstRunAccountSeed()).toBeUndefined();
    expect(parseFirstRunAccountSeed("  ")).toBeUndefined();
    const seed = parseFirstRunAccountSeed("unlinked");
    expect(seed).toEqual({ linked: null, communities: [] });
    if (!seed) throw new Error("unreachable");
    const account = seededAccount(seed);
    expect(await account.linkedKey()).toBeNull();
    expect(await account.ownedCommunities()).toEqual([]);
  });

  it("decodes the npub to hex and canonicalizes the owned hosts", async () => {
    const seed = parseFirstRunAccountSeed(
      JSON.stringify({
        npub: npubEncode(pubkey),
        communities: ["Design.Example.com", "wss://buzz.example.org:8443"],
      }),
    );
    expect(seed).toEqual({
      linked: pubkey,
      communities: [
        { host: "design.example.com", url: "https://design.example.com" },
        { host: "buzz.example.org:8443", url: "https://buzz.example.org:8443" },
      ],
    });
    if (!seed) throw new Error("unreachable");
    expect(await seededAccount(seed).linkedKey()).toBe(pubkey);
    expect(
      parseFirstRunAccountSeed(JSON.stringify({ npub: npubEncode(pubkey) })),
    ).toEqual({ linked: pubkey, communities: [] });
  });

  it.each([
    ["garbage", "linked"],
    ["an array", "[]"],
    ["a private key", JSON.stringify({ npub: nsecEncode(new Uint8Array(32)) })],
    ["hex instead of an npub", JSON.stringify({ npub: pubkey })],
    [
      "an unknown field",
      JSON.stringify({ npub: npubEncode(pubkey), secret: "s3cret" }),
    ],
    [
      "a non-string host",
      JSON.stringify({ npub: npubEncode(pubkey), communities: [1] }),
    ],
    [
      "an insecure host",
      JSON.stringify({
        npub: npubEncode(pubkey),
        communities: ["http://s3cret.example"],
      }),
    ],
  ])("rejects %s without echoing it", (_label, raw) => {
    expect(() => parseFirstRunAccountSeed(raw)).toThrow(
      /^BUZZ_DEV_FIRST_RUN_ACCOUNT must be/,
    );
    expect(() => parseFirstRunAccountSeed(raw)).not.toThrow(/s3cret/);
  });
});
