import { expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import { PRIMARY_LABEL, primaryPin, primaryTags } from "./primary";
import { SOLO_LABEL } from "./labels";

it("admits the primary through the actual agent session inventory and observes conversion", async () => {
  const owner = keypair(),
    agent = keypair(),
    relay = keypair();
  const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
  const binding = signed(owner, {
    kind: 45010,
    tags: [
      ["ar", "1"],
      ["d", crypto.randomUUID()],
      ["h", channel],
      ["type", PRIMARY_LABEL],
      ["op", "create"],
    ],
    content: JSON.stringify({
      version: 1,
      owner: owner.pubkey,
      identity: agent.pubkey,
      mode: "automatic",
      defaults: "harness-default",
    }),
  });
  let labels = [SOLO_LABEL, PRIMARY_LABEL, primaryPin(binding.id)];
  const library = vi.fn(async () => ({
    definitions: [],
    identities: [{ pubkey: agent.pubkey, name: "Primary" }],
  }));
  const session = createRelaySession(
    {
      viewer: agent.pubkey,
      relayAuthor: relay.pubkey,
      channelIdentity: true,
      media: (url) => url,
      readAgentLibrary: library,
      writer: {
        kinds: [9, 9007],
        sign: async (template) => signed(agent, template),
        publish: async () => {},
      },
      query: async (filters) =>
        [
          binding,
          metadata(relay, channel, "Chat", undefined, [
            ["private"],
            ["P", owner.pubkey],
            ["t", "stream"],
            ...labels.map((label) => ["t", label]),
          ]),
          roster(relay, channel, [owner.pubkey, agent.pubkey]),
          signed(relay, {
            kind: 39001,
            content: "",
            tags: [
              ["d", channel],
              ["p", owner.pubkey, "owner"],
            ],
          }),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  const message = signed(owner, {
    kind: 9,
    content: "An owner request",
    tags: [
      ["h", channel],
      ["p", agent.pubkey],
      ...primaryTags({
        identity: agent.pubkey,
        revision: binding.id,
        targeting: "implicit",
      }),
    ],
  });
  try {
    session.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(session.session.channels.list().status).toBe("ready"),
    );
    expect(
      await session.session.soloPrimary?.current(message, agent.pubkey),
    ).toBe(true);
    expect(library).toHaveBeenCalled();
    expect(
      session.session.agentChoices
        .snapshot()
        .selectable.map((choice) => choice.pubkey),
    ).toContain(agent.pubkey);
    labels = labels.filter((label) => label !== SOLO_LABEL);
    expect(
      await session.session.soloPrimary?.current(message, agent.pubkey),
    ).toBe(false);
    const explicit = signed(owner, {
      ...message,
      tags: [
        ["h", channel],
        ["p", agent.pubkey],
        ...primaryTags({
          identity: agent.pubkey,
          revision: binding.id,
          targeting: "explicit",
        }),
      ],
    });
    expect(
      await session.session.soloPrimary?.current(explicit, agent.pubkey),
    ).toBe(true);
    session.dispose();
    expect(() =>
      session.session.soloPrimary?.current(explicit, agent.pubkey),
    ).toThrow();
  } finally {
    session.dispose();
  }
});
