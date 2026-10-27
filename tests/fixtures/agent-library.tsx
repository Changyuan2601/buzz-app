import { agentAvatars } from "../../src/features/agents/avatar-packs";
import { createRoot } from "react-dom/client";
import { CreationReview } from "../../src/bundled/agents/CreationReview";
import { UpdateReview } from "../../src/bundled/agents/UpdateReview";
import { AgentsPage } from "../../src/bundled/agents/AgentsPage";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  AgentCreationRequest,
  AgentUpdateRequest,
  NewAgent,
} from "../../src/features/agents/service";
import type { RelayData } from "../../src/features/relay/service";
import { AgentInstructions } from "../../src/features/agents/AgentInstructions";
import { CreateModelChoices } from "../../src/features/agents/CreateModelChoices";
import { ModelPicker } from "../../src/features/agents/ModelPicker";
import "../../src/shared/styles/globals.css";

const inheritedModel = new URLSearchParams(location.search).get(
  "inheritedModel",
);

const type: RegisteredAgentType = {
  key: "fixture/agent",
  pluginId: "fixture",
  revision: "1",
  id: "agent",
  title: "Fixture",
  description: "Fixture agent",
  defaults: () => ({ config: {} }),
  adopt: ({ instructions }, config) => ({
    ...(config as object),
    instructions,
  }),
  Create: ({ config, disabled, onChange }) => (
    <AgentInstructions
      value={(config as { instructions?: string }).instructions ?? ""}
      disabled={disabled}
      onChange={(instructions) =>
        onChange({ ...(config as object), instructions })
      }
      creation
    />
  ),
  CreateModel: ({ disabled, modelAppearance }) =>
    inheritedModel !== null ? (
      <ModelPicker
        compact
        groupByFamily
        appearance={modelAppearance}
        models={[{ id: inheritedModel, label: inheritedModel }]}
        value=""
        defaultModel={inheritedModel}
        defaultLabel={inheritedModel}
        effortLabel="Automatic"
        disabled={disabled}
        onChange={() => {}}
      />
    ) : (
      <CreateModelChoices
        modelAppearance={modelAppearance}
        models={[{ id: "example", label: "Example model" }]}
        value="example"
        defaultLabel=""
        includeDefault={false}
        disabled={disabled}
        onChange={() => {}}
      />
    ),
};
const snapshot = {
  status: "ready" as const,
  running: [] as Agent[],
  teams: [],
  agents: ["Ada", "Bo", "Cy"].map(
    (name, index) =>
      ({
        pubkey: String(index + 1).repeat(64),
        key: String(index + 1).repeat(64),
        owner: "f".repeat(64),
        type: type.key,
        name,
        picture: agentAvatars[index]?.url,
        config: {},
        relay: "",
        place: "here",
        skipped: {},
        timers: {},
        attention: {},
        attentionEnabled: true,
      }) as Agent,
  ),
};
const other: RegisteredAgentType = {
  ...type,
  key: "fixture/other",
  id: "other",
  title: "Other",
};
const reviewing = new URLSearchParams(location.search).has("review");
const changing = new URLSearchParams(location.search).has("change");
const types = changing ? [type, other] : [type];
if (changing) snapshot.running = snapshot.agents;
let updates: readonly AgentUpdateRequest[] = changing
  ? [
      {
        id: "change",
        requester: "a".repeat(64),
        requesterName: "Parent",
        owner: "f".repeat(64),
        community: "https://relay.example",
        agent: "1".repeat(64),
        agentName: "Ada",
        agentType: type.key,
        name: "Ada Reviewer",
        type: other.key,
        instructions: "Review pull requests before they merge.",
      },
    ]
  : [];
const changed: NewAgent[] = [];
const failFirstApproval = new URLSearchParams(location.search).has("fail");
let approvalAttempts = 0;
let requests: readonly AgentCreationRequest[] = reviewing
  ? [
      {
        id: "draft",
        requester: "a".repeat(64),
        requesterName: "Parent",
        owner: "f".repeat(64),
        community: "https://relay.example",
        type: type.key,
        name: "Child",
      },
    ]
  : [];
const listeners = new Set<() => void>();
const reviewed: NewAgent[] = [];
const dismissCreation = () => {
  requests = [];
  for (const listener of listeners) listener();
};
const dismissUpdate = () => {
  updates = [];
  for (const listener of listeners) listener();
};
Object.assign(window, {
  creationReviewResult: () => reviewed,
  updateReviewResult: () => changed,
});
const agents = {
  snapshot: () => snapshot,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  creationRequests: () => requests,
  dismissCreation,
  approveCreation: async (_id: string, input: NewAgent) => {
    if (failFirstApproval && ++approvalAttempts === 1)
      throw new Error("Credential store refused");
    reviewed.push(input);
    dismissCreation();
    return {} as Agent;
  },
  updateRequests: () => updates,
  dismissUpdate,
  approveUpdate: async (_id: string, input: NewAgent) => {
    changed.push(input);
    dismissUpdate();
  },
  previewRetype: () => ({
    config: {},
    moved: ["instructions"],
    dropped: ["workspace"],
    settings: [],
  }),
  types: () => types,
  find: (pubkey: string) =>
    snapshot.agents.find((agent) => agent.pubkey === pubkey),
  memberships: () => [],
  joinable: () => [],
  relay: () => undefined,
  save: async () => {},
  classifier: () => "unavailable",
} as unknown as Agents;
const disconnected = { status: "disconnected", generation: 0 };
const relay = {
  snapshot: () => disconnected,
  subscribe: () => () => {},
} as unknown as RelayData;
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <div className="h-screen">
    <AgentsPage agents={agents} relay={relay} />
    {reviewing && <CreationReview agents={agents} />}
    {changing && <UpdateReview agents={agents} />}
  </div>,
);
