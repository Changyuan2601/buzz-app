import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDraftProtection } from "../../features/drafts/DraftProtection";
import { DraftScope, useDraftState } from "../../features/drafts/react";
import { useAgents2 } from "../../features/agents2/react";
import type {
  Agent,
  Agents2,
  RegisteredAgentType,
} from "../../features/agents2/service";
import type { Panels } from "../../features/panels/service";
import { PanelView } from "../../features/panels/PanelView";
import { profileTarget } from "../../features/profiles/target";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import styles from "./Agents2Page.module.css";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const noSubscribe = () => () => {};
const emptyPanels: readonly never[] = [];
const noPanels = () => emptyPanels;
type Opening = {
  pubkey?: string;
  session: unknown;
  scope: string | undefined;
  viewer: string | undefined;
};

/** One modal host for creation and the registered canonical profile. */
export function AgentProfileDialog({
  agents2,
  relay,
  panels,
  pubkey,
  onClose,
}: {
  agents2: Agents2;
  relay: RelayData;
  panels?: Panels | undefined;
  pubkey?: string | undefined;
  onClose(): void;
}) {
  const { snapshot, types } = useAgents2(agents2);
  const connection = useRelayConnection(relay);
  const guard = useDraftProtection();
  const [opening, setOpening] = useState<Opening>(() => ({
    ...(pubkey ? { pubkey } : {}),
    session: connection.session,
    scope: connection.scope,
    viewer: connection.viewer,
  }));
  const openingRef = useRef(opening);
  openingRef.current = opening;
  const trigger = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const available = useSyncExternalStore(
    panels?.subscribe ?? noSubscribe,
    panels?.snapshot ?? noPanels,
    noPanels,
  );
  const agent = snapshot.agents.find((item) => item.pubkey === opening?.pubkey);
  const target = agent && profileTarget(agent.pubkey, { agent: true });
  const panel = target ? panels?.resolve(target) : undefined;
  const current =
    opening &&
    opening.session === connection.session &&
    opening.scope === connection.scope &&
    opening.viewer === connection.viewer;
  const visible = !!current && (!opening.pubkey || !!agent);
  useEffect(() => {
    if (!visible) onClose();
  }, [visible, onClose]);
  const close = (force = false) => {
    const admitted = openingRef.current;
    if (!force && guard?.hasRisk(admitted)) {
      void guard.request(admitted).then((leave) => {
        if (leave && openingRef.current === admitted) onClose();
      });
    } else onClose();
  };
  return (
    <Dialog
      open={visible}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={agent ? "Agent profile" : "New agent"}
      size="wide"
      height="stable"
      finalFocus={trigger}
    >
      {visible && opening && (
        <DraftScope scope={opening}>
          {!opening.pubkey ? (
            <NewAgent
              agents2={agents2}
              types={types}
              onCreated={(created) => {
                if (openingRef.current !== opening) return;
                if (agents2.find(created.pubkey))
                  setOpening({ ...opening, pubkey: created.pubkey });
                else onClose();
              }}
            />
          ) : agent && panel && target && available.includes(panel) ? (
            <PanelView
              key={`${panel.key}:${panel.revision}:${target}`}
              panel={panel}
              target={target}
              close={() => close(true)}
            />
          ) : (
            <p role="status">Enable Profiles to view and edit this agent.</p>
          )}
        </DraftScope>
      )}
    </Dialog>
  );
}

function NewAgent({
  agents2,
  types,
  onCreated,
}: {
  agents2: Agents2;
  types: readonly RegisteredAgentType[];
  onCreated(agent: Agent): void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState(types[0]?.key ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useDraftState(
    "new agent",
    { dirty: !!name.trim(), saving: pending, revision: name + type },
    () => setName(""),
  );
  const chosen = types.find((item) => item.key === type) ?? types[0];
  const create = async () => {
    if (!chosen || !name.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      onCreated(await agents2.create({ type: chosen.key, name: name.trim() }));
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  return (
    <form
      className={styles.sideBody}
      aria-label="New agent"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <Field label="Name">
        <Input
          autoFocus
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Type">
        <RadioGroup
          value={chosen?.key ?? ""}
          disabled={pending}
          onValueChange={(value) => setType(String(value))}
        >
          {types.map((item) => (
            <Radio
              key={item.key}
              value={item.key}
              variant="card"
              label={item.title}
              {...(item.description ? { description: item.description } : {})}
            />
          ))}
        </RadioGroup>
      </Field>
      <p className="m-0 text-body-sm text-secondary">
        It gets its own key on this device and runs while the app is open.
      </p>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        loading={pending}
        disabled={!name.trim() || !chosen}
      >
        Create and set up
      </Button>
    </form>
  );
}
