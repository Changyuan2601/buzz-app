import { useState } from "react";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { Dialog } from "../../src/shared/design-system/ui/Dialog";
import { Button } from "../../src/shared/design-system/ui/Button";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { createRoot } from "react-dom/client";
import { ChannelMembersButton } from "../../src/bundled/channels/ChannelMembersDialog";
import {
  createRelaySession,
  type RelaySession,
} from "../../src/features/relay/session";
import { npubEncode } from "nostr-tools/nip19";
import { AgentOwnerPreview } from "../../src/features/profiles/AgentOwnerPreview";
import { publicKeyLabels } from "../../src/shared/identity/public-key";
import { IdentityRow } from "../../src/shared/identity/IdentityRow";
import { Checkbox } from "../../src/shared/design-system/ui/Checkbox";
import { Field } from "../../src/shared/design-system/ui/Field";
import { Input } from "../../src/shared/design-system/ui/Input";
import styles from "../../src/bundled/channels/ChannelTemplates.module.css";
import { PublishRejected } from "../../src/features/relay/outbox";
import { matchesEvent } from "../../src/features/relay/projection";
import { bindNames } from "../../src/features/identity-names/service";
import { createNameProvider } from "../../src/features/identity-names/directory";
import { resolveIdentityNames } from "../../src/features/identity-names/policy";
import {
  keypair,
  profile,
  roster,
  signed,
} from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";

const administration = new URLSearchParams(location.search).has(
  "administration",
);
const rejectRemoval = new URLSearchParams(location.search).has(
  "reject-removal",
);
const viewer = keypair();
const relay = keypair();
const person = keypair();
const candidates = new URLSearchParams(location.search).has("multiple")
  ? [1, 2, 3].map((index) => ({
      key: keypair(),
      name: `Morgan Field Tester ${index}`,
    }))
  : [{ key: person, name: "Morgan" }];
const candidateProfiles = candidates.map(({ key, name }) =>
  profile(key, { name }),
);
const holdNames = new URLSearchParams(location.search).has("loading");
let releaseNames = () => {};
const namesReady = new Promise<void>((resolve) => {
  releaseNames = resolve;
});
let namesRequested = false;
// A team long enough to scroll inside its dialog.
const team = new URLSearchParams(location.search).has("team")
  ? Array.from({ length: 12 }, (_, index) => ({
      pubkey: keypair().pubkey,
      name: `Agent ${index + 1}`,
    }))
  : [{ pubkey: person.pubkey, name: "Morgan" }];
const additions: string[] = [];
const channelId = "11111111-1111-4111-8111-111111111111";
// Only the scroll-dismissal journey needs an overflowing roster.
const scrollMembers = new URLSearchParams(location.search).has("scroll")
  ? Array.from({ length: 16 }, (_, index) => ({
      key: keypair(),
      name: `Member ${index + 1}`,
    }))
  : [];
// Real owner signatures for the opt-in search workload, not a mocked verifier.
const invitationScale = new URLSearchParams(location.search).has(
  "invitation-scale",
);
const inventory = invitationScale
  ? Array.from({ length: 240 }, (_, index) => ({
      pubkey: keypair().pubkey,
      name: `Helper ${String(index + 1).padStart(3, "0")}`,
    }))
  : [];
const searchScale = new URLSearchParams(location.search).has("search-scale");
const managed = searchScale
  ? Array.from({ length: 60 }, (_, index) => ({
      key: keypair(),
      name: `Agent ${index + 1}`,
    }))
  : [];
const managedProfiles = await Promise.all(
  managed.map(async ({ key, name }) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`nostr:agent-auth:${key.pubkey}:`),
    );
    return signed(key, {
      kind: 0,
      content: JSON.stringify({
        name,
        is_agent: true,
        picture: `https://example.test/${key.pubkey}.png`,
      }),
      tags: [
        [
          "auth",
          viewer.pubkey,
          "",
          bytesToHex(schnorr.sign(new Uint8Array(digest), viewer.secret)),
        ],
      ],
    });
  }),
);
const members = [
  viewer.pubkey,
  ...(administration ? [person.pubkey] : []),
  ...scrollMembers.map(({ key }) => key.pubkey),
  ...managed.map(({ key }) => key.pubkey),
];
const scrollProfiles = scrollMembers.map(({ key, name }) =>
  profile(key, { name }),
);
let clock = 1700000000;
let publishStarted = () => {};
let releasePublish = () => {};
const published = new Promise<void>((resolve) => {
  publishStarted = resolve;
});
const held = new Promise<void>((resolve) => {
  releasePublish = resolve;
});
const searchWork = { images: 0, observations: 0 };
const provider = createNameProvider({
  id: "fixture",
  resolve: resolveIdentityNames,
});
const { session: sharedSession } = createRelaySession(
  {
    viewer: viewer.pubkey,
    scope: "https://relay.example.test",
    relayAuthor: relay.pubkey,
    media: () => {
      searchWork.images++;
      return undefined;
    },
    readAgentLibrary: async () => ({ definitions: [], identities: inventory }),
    query: async (filters) => {
      if (filters.some((filter) => filter.search)) {
        // The roster-only workload must not introduce a new identity: random
        // npub suffix collisions legitimately change every row's key label.
        if (invitationScale || searchScale) return [];
        return candidateProfiles;
      }
      if (holdNames && filters.some((filter) => filter.kinds?.includes(0))) {
        namesRequested = true;
        await namesReady;
      }
      return [
        ...(administration
          ? [
              signed(relay, {
                kind: 39001,
                created_at: clock,
                content: "",
                tags: [
                  ["d", channelId],
                  ["p", viewer.pubkey, "owner"],
                ],
              }),
              signed(relay, {
                kind: 39002,
                created_at: clock,
                content: "",
                tags: [
                  ["d", channelId],
                  ...members.map((key) => [
                    "p",
                    key,
                    "",
                    key === viewer.pubkey ? "owner" : "member",
                  ]),
                ],
              }),
            ]
          : [roster(relay, channelId, members, clock)]),
        signed(relay, {
          kind: 39000,
          content: "",
          tags: [
            ["d", channelId],
            ["t", "stream"],
            ["private"],
            ["name", "Design"],
          ],
        }),
        profile(viewer, { name: "Carl" }),
        ...candidateProfiles,
        ...scrollProfiles,
        ...managedProfiles,
      ].filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
    ...(administration
      ? {
          memberAdministration: {
            sign: async (template: import("nostr-tools").EventTemplate) =>
              signed(viewer, template),
            publish: async () => {
              publishStarted();
              await held;
              if (rejectRemoval)
                throw new PublishRejected("Permission changed");
              members.splice(members.indexOf(person.pubkey), 1);
              clock++;
            },
          },
        }
      : {}),
    writer: {
      kinds: [9000],
      sign: async (template) => signed(viewer, template),
      publish: async (event) => {
        const key = event.tags.find(([tag]) => tag === "p")?.[1];
        if (!key) throw new Error("Missing added identity");
        additions.push(key);
        publishStarted();
        await held;
        members.push(key);
        clock++;
      },
    },
  },
  {
    outboxStorage: { load: () => [], save: () => {} },
    identityNames: {
      register() {},
      bind(source) {
        const names = bindNames(source, {
          snapshot: () => [provider],
          subscribe: () => () => {},
        });
        return names;
      },
    },
  },
);
const session: typeof sharedSession = {
  ...sharedSession,
  observe(...args) {
    if (
      args[0].some(
        (filter) =>
          filter.kinds?.includes(0) &&
          filter.authors?.some((key) =>
            managed.some((agent) => agent.key.pubkey === key),
          ),
      )
    )
      searchWork.observations++;
    return sharedSession.observe(...args);
  },
};
session.channels.ensureList();
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
// A searchable checklist of identity rows, as a picker inside a dialog would
// show them, so previews are exercised inside a modal's own scroller.
function IdentityChecklist({
  session,
  selected,
  agents,
  onChange,
}: {
  session: RelaySession;
  selected: readonly string[];
  agents: readonly { pubkey: string; name: string }[];
  onChange(keys: string[]): void;
}) {
  const [search, setSearch] = useState("");
  const labels = publicKeyLabels(agents.map((agent) => agent.pubkey));
  const matches = agents.filter((agent) =>
    `${agent.name} ${npubEncode(agent.pubkey)} ${agent.pubkey}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className={styles.stack}>
      <Field label="Find individual agents">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or npub"
        />
      </Field>
      <div className={styles.choices}>
        {matches.map((agent) => (
          <IdentityRow
            key={agent.pubkey}
            pubkey={agent.pubkey}
            name={agent.name}
            isAgent
            previewDetail={
              <AgentOwnerPreview session={session} pubkey={agent.pubkey} />
            }
            keyLabel={labels.get(agent.pubkey)}
            render={(content, previewProps) => (
              <Checkbox
                {...previewProps}
                label={content}
                checked={selected.includes(agent.pubkey)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...selected, agent.pubkey]
                      : selected.filter((key) => key !== agent.pubkey),
                  )
                }
              />
            )}
          />
        ))}
      </div>
    </div>
  );
}
function Fixture() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <ToastProvider>
      <ChannelMembersButton
        session={session}
        channelId={channelId}
        canOpenLink={() => true}
        onOpenLink={() => true}
      />
      <Button onClick={() => setOpen(true)}>Edit team</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Team">
        <IdentityChecklist
          session={session}
          selected={selected}
          onChange={setSelected}
          agents={team}
        />
      </Dialog>
    </ToastProvider>
  );
}
createRoot(root).render(<Fixture />);
// The test controls when confirmation arrives; no relay or member is contacted.
Object.assign(window, {
  focusFixture: {
    searchWork,
    published,
    namesRequested: () => namesRequested,
    releaseNames: () => releaseNames(),
    additions,
    confirm: () => releasePublish(),
  },
});
