import { AgentProfileDialog } from "../../src/bundled/agents2/AgentProfileDialog";
import { useAgents2 } from "../../src/features/agents2/react";
import { Field } from "../../src/shared/design-system/ui/Field";
import { ProfilePanel } from "../../src/bundled/profiles/ProfilePanel";
import { createRelaySession } from "../../src/features/relay/session";
import { createDraftGuard } from "../../src/features/drafts/guard";
import { DraftProtection } from "../../src/features/drafts/DraftProtection";
import type {
  Panels,
  RegisteredPanel,
} from "../../src/features/panels/service";
import { Textarea } from "../../src/shared/design-system/ui/Textarea";
import type { AgentViewProps } from "../../src/features/agents2/service";
import { useEffect, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";
import "./agents2.css";
import { AgentInventory } from "../../src/bundled/agents2/AgentInventory";
import { Agents2Page } from "../../src/bundled/agents2/Agents2Page";
import { NewAgentCard } from "../../src/bundled/agents2/NewAgentCard";
import type {
  Agent,
  Agents2,
  AgentsSnapshot,
  RegisteredAgentType,
} from "../../src/features/agents2/service";
import type { RelayData } from "../../src/features/relay/service";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { CollectionCard } from "../../src/shared/design-system/ui/CollectionCard";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import { Button } from "../../src/shared/design-system/ui/Button";
import { IconButton } from "../../src/shared/design-system/ui/IconButton";
import { FullPageSurface } from "../../src/shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../src/shared/design-system/ui/PanelHeader";
import { InlineHeader } from "../../src/shared/design-system/ui/Header";
import { Select } from "../../src/shared/design-system/ui/Select";
import { Dialog } from "../../src/shared/design-system/ui/Dialog";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../src/shared/design-system/ui/Menu";
import { PlusIcon } from "../../src/shared/design-system/icons";
import fish from "../../src/bundled/agents2/artwork/fuzzies-4.webp";
import dog from "../../src/bundled/agents2/artwork/pollies-24.webp";
import capybara from "../../src/bundled/agents2/artwork/fuzzies-18.webp";
import person from "../../src/bundled/agents2/artwork/pollies-1.webp";
import tomato from "../../src/bundled/agents2/artwork/gloopies-3.webp";
import helmet from "../../src/bundled/agents2/artwork/gloopies-20.webp";

const samples = [
  {
    name: "codebot",
    description: "A second pair of eyes on your code.",
    image: fish,
  },
  {
    name: "wordbot",
    description: "Find the words you were looking for.",
    image: dog,
  },
  {
    name: "designbot",
    description: "Explore a different perspective.",
    image: capybara,
  },
  {
    name: "architectbot",
    description: "Think through the bigger picture.",
    image: person,
  },
  {
    name: "researchbot",
    description: "Follow a question a little further.",
    image: tomato,
  },
  {
    name: "qualitybot",
    description: "Check the details before you ship.",
    image: helmet,
  },
];
function SampleSettings({ agent, save, reportDraft }: AgentViewProps) {
  const saved = typeof agent.config === "string" ? agent.config : "";
  const [text, setText] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    reportDraft?.({
      dirty: text !== saved,
      saving,
      revision: text,
      discard: () => setText(saved),
    });
  }, [text, saved, saving, reportDraft]);
  return (
    <div className="grid gap-3">
      <Field label="Instructions">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button disabled={saving} onClick={() => setText(saved)}>
          Discard
        </Button>
        <Button
          variant="prominent"
          disabled={saving || text === saved}
          onClick={() => {
            setSaving(true);
            void save(text).finally(() => setSaving(false));
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

const type: RegisteredAgentType = {
  key: "preview/example",
  pluginId: "preview",
  revision: "1",
  id: "example",
  title: "Example type",
  defaults: () => ({ config: {} }),
  tabs: [{ id: "settings", title: "Settings", component: SampleSettings }],
  summary: () => "Sample agent",
};
const makeAgent = (name: string, n: number): Agent => ({
  pubkey: n.toString(16).padStart(64, "0"),
  name,
  type: type.key,
  owner: "f".repeat(64),
  relay: "wss://preview.invalid",
  config: {},
  attention: {},
  skipped: {},
  timers: {},
});

// In-memory UI fixture only. No native host, credentials, network or persistence.
function previewService(count: number): Agents2 {
  let snapshot: AgentsSnapshot = {
    status: "ready",
    agents: Array.from({ length: count }, (_, n) =>
      makeAgent(samples[n % samples.length]?.name ?? "Example", n + 1),
    ),
  };
  const types = [type];
  let next = count + 1;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    types: () => types,
    snapshot: () => snapshot,
    register: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    find: (key) => snapshot.agents.find((agent) => agent.pubkey === key),
    create: async ({ name }) => {
      const agent = makeAgent(name, next++);
      snapshot = { ...snapshot, agents: [...snapshot.agents, agent] };
      notify();
      return agent;
    },
    save: async (key, change) => {
      snapshot = {
        ...snapshot,
        agents: snapshot.agents.map((agent) =>
          agent.pubkey === key
            ? { ...agent, ...change, attention: agent.attention }
            : agent,
        ),
      };
      notify();
    },
    remove: async (key) => {
      snapshot = {
        ...snapshot,
        agents: snapshot.agents.filter((agent) => agent.pubkey !== key),
      };
      notify();
    },
  };
}
const fixtureSession = createRelaySession(null);
const ready = {
  status: "ready" as const,
  generation: 1,
  session: fixtureSession.session,
  viewer: "f".repeat(64),
  scope: `https://preview.invalid:${"f".repeat(64)}`,
};
const relay: RelayData = {
  snapshot: () => ready,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  clearCache: async () => {},
};
const drafts = createDraftGuard();
function previewPanels(agents2: Agents2): Panels {
  const panel: RegisteredPanel = {
    key: "preview/profile",
    id: "profile",
    pluginId: "preview",
    revision: "1",
    title: "Profile",
    matches: () => true,
    component: (props) => (
      <ProfilePanel {...props} agents2={agents2} relay={relay} />
    ),
  };
  const panels = [panel];
  return {
    resolve: () => panel,
    snapshot: () => panels,
    subscribe: () => () => {},
    register() {},
  };
}

function CommunityPreview({ count }: { count: number }) {
  const [service] = useState(() => previewService(count));
  const panels = useMemo(() => previewPanels(service), [service]);
  const { snapshot } = useAgents2(service);
  const [profile, setProfile] = useState<{ pubkey?: string }>();
  const [selected, setSelected] = useState<string>();
  const owned = snapshot.agents;
  const [catalog, setCatalog] = useState(false);
  const [detail, setDetail] = useState<string>();
  const [notice, setNotice] = useState("");
  const inline = owned.length <= 3;
  const add = async (sample: (typeof samples)[number]) => {
    if (
      !service.snapshot().agents.some((agent) => agent.name === sample.name)
    ) {
      await service.create({ type: type.key, name: sample.name });
    }
    setNotice(`${sample.name} added to this preview only.`);
  };
  const create = () => setProfile({});
  const community = (
    <div className="agents-preview-collection-grid">
      {samples.map((sample) => {
        const added = owned.some((item) => item.name === sample.name);
        return (
          <CollectionCard
            key={sample.name}
            artwork={
              <Avatar
                src={sample.image}
                alt=""
                fallback={sample.name}
                size="fill"
                shape="squircle"
              />
            }
            title={
              <Button
                variant="link"
                onClick={() => {
                  setCatalog(false);
                  setDetail(sample.name);
                }}
              >
                {sample.name}
              </Button>
            }
            description={added ? "Added to preview" : sample.description}
            action={
              <IconButton
                aria-label={`Add ${sample.name}`}
                size="sm"
                variant="prominent"
                shape="round"
                icon={<PlusIcon size={16} />}
                disabled={added}
                onClick={() => add(sample)}
              />
            }
          />
        );
      })}
    </div>
  );
  return (
    <FullPageSurface aria-label="Community agents concept">
      <div className="agents-preview-page">
        <PanelHeader
          title={<PanelHeaderLabel title="Agents2" />}
          actions={
            <MenuRoot>
              <MenuTrigger
                render={
                  <IconButton
                    aria-label="New agent menu"
                    size="sm"
                    icon={<PlusIcon size={16} />}
                  />
                }
              />
              <MenuPopup>
                <MenuItem onClick={create}>Create a new agent</MenuItem>
                <MenuItem onClick={() => setCatalog(true)}>
                  Browse community agents
                </MenuItem>
              </MenuPopup>
            </MenuRoot>
          }
        />
        <div className="agents-preview-scroll">
          {owned.length ? (
            <section className="agents-preview-owned" aria-label="Owned agents">
              <AgentInventory
                agents={owned}
                selected={selected}
                typeOf={() => type}
                onSelect={setSelected}
                onBuild={(pubkey) => setProfile({ pubkey })}
                onCreate={create}
                creating={false}
              />
            </section>
          ) : (
            <div className="agents-preview-empty">
              <NewAgentCard onCreate={create} />
            </div>
          )}
          {inline && (
            <section
              className="agents-preview-community"
              aria-label="Community agents"
            >
              <InlineHeader title="Browse community agents" />
              {community}
            </section>
          )}
          <p className="text-body-sm text-secondary" role="status">
            {notice}
          </p>
        </div>
      </div>
      <Dialog
        open={catalog}
        onOpenChange={setCatalog}
        title="Community agents"
        description="Sample agents. Adding here only changes this preview."
        size="wide"
      >
        {community}
      </Dialog>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined);
        }}
        title={detail ?? "Sample agent"}
      >
        <div className="grid gap-4">
          <p>{samples.find((sample) => sample.name === detail)?.description}</p>
          <p className="text-body-sm text-secondary">
            Sample only. This does not install or run an agent.
          </p>
          <Button
            variant="prominent"
            disabled={owned.some((item) => item.name === detail)}
            onClick={() => {
              const sample = samples.find((item) => item.name === detail);
              if (sample) add(sample);
            }}
          >
            {owned.some((item) => item.name === detail)
              ? "Added to preview"
              : "Add to preview"}
          </Button>
        </div>
      </Dialog>
      {profile && (
        <AgentProfileDialog
          agents2={service}
          panels={panels}
          relay={relay}
          pubkey={profile.pubkey}
          onClose={() => setProfile(undefined)}
        />
      )}
    </FullPageSurface>
  );
}

function Preview() {
  useKeyboardFocusVisibility();
  const [count, setCount] = useState("0");
  const [mode, setMode] = useState("community");
  const [dark, setDark] = useState(false);
  const [large, setLarge] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
    document.documentElement.style.fontSize = large ? "200%" : "";
  }, [dark, large]);
  const [service, setService] = useState(() => previewService(0));
  const panels = useMemo(() => previewPanels(service), [service]);
  return (
    <main className="agents-preview-host">
      <div className="agents-preview-tools">
        <span className="text-label-sm">Design preview · sample data only</span>
        <Select
          label="View"
          value={mode}
          onValueChange={setMode}
          groups={[
            {
              label: "",
              options: [
                { value: "community", label: "Community concept" },
                { value: "real", label: "Real page" },
              ],
            },
          ]}
        />
        <Select
          label="Owned agents"
          value={count}
          onValueChange={(value) => {
            setCount(value);
            setService(previewService(Number(value)));
          }}
          groups={[
            {
              label: "",
              options: [0, 1, 3, 6].map((n) => ({
                value: String(n),
                label: String(n),
              })),
            },
          ]}
        />
        <Button onClick={() => setDark(!dark)}>
          {dark ? "Light theme" : "Dark theme"}
        </Button>
        <Button onClick={() => setLarge(!large)}>
          {large ? "Normal text" : "Enlarge text"}
        </Button>
      </div>
      <div className="agents-preview-stage">
        {mode === "real" ? (
          <Agents2Page
            key={count}
            agents2={service}
            relay={relay}
            panels={panels}
          />
        ) : (
          <CommunityPreview key={count} count={Number(count)} />
        )}
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <DraftProtection guard={drafts}>
      <Preview />
    </DraftProtection>,
  );
