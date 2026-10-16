import { agentAvatars } from "../../src/features/agents/avatar-packs";
import { createRoot } from "react-dom/client";
import { AgentsPage } from "../../src/bundled/agents/AgentsPage";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../src/features/agents/service";
import type { RelayData } from "../../src/features/relay/service";
import { AgentInstructions } from "../../src/features/agents/AgentInstructions";
import { CreateModelChoices } from "../../src/features/agents/CreateModelChoices";
import "../../src/shared/styles/globals.css";

const type: RegisteredAgentType = {
  key: "fixture/agent",
  pluginId: "fixture",
  revision: "1",
  id: "agent",
  title: "Fixture",
  description: "Fixture agent",
  defaults: () => ({ config: {} }),
  Create: () => (
    <AgentInstructions value="" disabled={false} onChange={() => {}} creation />
  ),
  CreateModel: ({ disabled, modelAppearance }) => (
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
  running: [],
  teams: [],
  agents: ["Ada", "Bo", "Cy"].map(
    (name, index) =>
      ({
        pubkey: String(index + 1).repeat(64),
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
const types = [type];
const agents = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  types: () => types,
  find: (pubkey: string) =>
    snapshot.agents.find((agent) => agent.pubkey === pubkey),
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
  </div>,
);
