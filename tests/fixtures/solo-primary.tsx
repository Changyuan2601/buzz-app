import "../../src/shared/styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRelaySession } from "../../src/features/relay/session";
import { keypair, signed, profile } from "../../src/features/relay/testing";
import { matchesEvent } from "../../src/features/relay/projection";
import { uuidv5 } from "../../src/features/agents/agent-config-artifacts";
import { PRIMARY_LABEL, primaryPin } from "../../src/features/solo/primary";
import { SOLO_LABEL } from "../../src/features/solo/labels";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import type { RelayEvent } from "../../src/features/relay/events";
import type { EventTemplate } from "nostr-tools";

const viewer = keypair(),
  relay = keypair(),
  agent = keypair();
const id = "11111111-1111-4111-8111-111111111111";
let clock = 100;
const adopted = !new URLSearchParams(location.search).has("legacy");
let labels = [SOLO_LABEL, ...(adopted ? [PRIMARY_LABEL] : [])];
let binding: RelayEvent | undefined = adopted
  ? signed(viewer, {
      kind: 45010,
      created_at: clock,
      tags: [
        ["ar", "1"],
        ["h", id],
        ["d", await uuidv5(id, PRIMARY_LABEL)],
        ["type", PRIMARY_LABEL],
        ["op", "create"],
        ["title", "Solo primary agent"],
      ],
      content: JSON.stringify({
        version: 1,
        owner: viewer.pubkey,
        identity: agent.pubkey,
        mode: "automatic",
        defaults: "harness-default",
      }),
    })
  : undefined;
if (binding) labels.push(primaryPin(binding.id));
const history = new Map<string, RelayEvent>(
  binding ? [[binding.id, binding]] : [],
);
const messages: RelayEvent[] = [];
const record = (kind: number, tags: string[][]) =>
  signed(relay, {
    kind,
    created_at: clock,
    tags: [["d", id], ...tags],
    content: "",
  });
const sign = async (template: EventTemplate) =>
  signed(viewer, structuredClone(template));
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    channelIdentity: true,
    readAgentLibrary: async () => ({
      definitions: [],
      identities: [{ pubkey: agent.pubkey, name: "Honey" }],
    }),
    query: async (filters) => {
      const events = [
        record(39000, [
          ["name", "Planning"],
          ["P", viewer.pubkey],
          ["t", "stream"],
          ["private"],
          ...labels.map((label) => ["t", label]),
        ]),
        record(39001, [["p", viewer.pubkey, "owner"]]),
        record(39002, [
          ["p", viewer.pubkey, "", "owner"],
          ["p", agent.pubkey],
        ]),
        profile(viewer, { name: "You" }),
        profile(agent, { name: "Honey", is_agent: true }),
        ...history.values(),
        ...messages,
      ];
      return events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
    configArtifacts: {
      sign,
      publish: async (event) => {
        binding = event;
        history.set(event.id, event);
      },
    },
    channelDetails: {
      sign,
      publish: async (event) => {
        labels = event.tags
          .filter(([name]) => name === "t")
          .flatMap((tag) => (tag[1] ? [tag[1]] : []))
          .filter((value) => value !== "stream");
        clock++;
      },
    },
    writer: {
      kinds: [9, 9007],
      sign,
      publish: async (event) => {
        messages.push(event);
      },
    },
  },
  { outboxStorage: { load: () => [], save: () => {} } },
);
owner.session.channels.ensureList();
Object.assign(window, {
  soloPrimaryFixture: {
    published: () => messages.map(({ content, tags }) => ({ content, tags })),
  },
});
function Fixture() {
  useKeyboardFocusVisibility();
  return (
    <ToastProvider>
      <main
        style={{ padding: "var(--space-4)", maxWidth: 720, margin: "auto" }}
      >
        <MessageComposer
          session={owner.session}
          scope="solo-primary-fixture"
          channelId={id}
          channelName="Planning"
          ownSoloConversation
          requireMention
        />
      </main>
    </ToastProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
