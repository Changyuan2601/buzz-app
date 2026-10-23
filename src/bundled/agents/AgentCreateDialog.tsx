// Agent identity above the type-owned model and instructions fields.
import { useId, useRef, useState } from "react";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  NewAgent,
  AgentCreationRequest,
  AgentUpdateRequest,
} from "../../features/agents/service";
import { RobotIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { AgentCreateHeader } from "./AgentCreateHeader";
import { MigrationPreview } from "./AgentSettingsHost";
import styles from "./AgentCreate.module.css";
import { useNamePrompt } from "./useNamePrompt";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
// A failed save's error sits below the whole form, often out of view.
const reveal = (element: HTMLElement | null) => {
  element?.scrollIntoView({ block: "nearest" });
};

/** Use each registered provider's icon in creation and library cards. */
export function TypeIcon({ type }: { type: RegisteredAgentType | undefined }) {
  const Icon = type?.icon ?? RobotIcon;
  return <Icon size={16} aria-hidden="true" />;
}

const startingConfig = (type: RegisteredAgentType | undefined) => {
  try {
    return type?.defaults().config;
  } catch {
    return undefined;
  }
};

export function AgentCreateDialog({
  agents,
  types,
  community,
  onClose,
  onCreated,
  request,
  onCreate,
  update,
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  community?: string | undefined;
  onClose(): void;
  onCreated(agent: Agent): void;
  request?: AgentCreationRequest;
  onCreate?(input: NewAgent): Promise<Agent>;
  /** Edits `agent` instead, starting from its settings with the request's
   * changes. */
  update?: Readonly<{
    agent: Agent;
    request: AgentUpdateRequest;
    onSave(input: NewAgent): Promise<void>;
  }>;
}) {
  const edited = update?.agent;
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(
    update ? (update.request.name ?? update.agent.name) : (request?.name ?? ""),
  );
  const [picture, setPicture] = useState(() =>
    update ? (update.agent.picture ?? "") : randomAgentAvatar().url,
  );
  const [typeKey, setTypeKey] = useState(
    (update ? (update.request.type ?? update.agent.type) : request?.type) ??
      types[0]?.key ??
      "",
  );
  const type = types.find((item) => item.key === typeKey) ?? types[0];
  const migration = (item: RegisteredAgentType | undefined) => {
    if (!edited || !item || item.key === edited.type) return undefined;
    try {
      return agents.previewRetype(edited.pubkey, item.key);
    } catch {
      return undefined;
    }
  };
  /** The agent's settings in `item`, with the requested instructions. */
  const seed = (item: RegisteredAgentType | undefined) => {
    if (!update) return startingConfig(item);
    const { agent, request } = update;
    const config =
      item?.key === agent.type
        ? agent.config
        : (migration(item)?.config ?? startingConfig(item));
    return request.instructions !== undefined && item?.adopt
      ? item.adopt({ instructions: request.instructions }, config)
      : config;
  };
  const [config, setConfig] = useState(() => seed(type));
  const preview = migration(type);
  const [dirty, setDirty] = useState(Boolean(update));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [avatarActive, setAvatarActive] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarAction, setAvatarAction] = useState<HTMLDivElement | null>(null);
  const avatarNavigation = useRef<{ back(): void }>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const namePrompt = useNamePrompt(nameField);
  const form = useId();
  const Create = type?.Create;
  const Model = type?.CreateModel;
  const close = () => setOpen(false);
  const chooseModel = (item: RegisteredAgentType, next: unknown) => {
    setTypeKey(item.key);
    setConfig(next);
    setDirty(true);
    setError("");
  };
  const choose = (key: string) => {
    const item = types.find((candidate) => candidate.key === key);
    if (item && key !== type?.key) chooseModel(item, seed(item));
  };
  const create = async () => {
    if (!type || pending) return;
    if (!name.trim()) {
      namePrompt.prompt();
      return;
    }
    setPending(true);
    setError("");
    const input = {
      type: type.key,
      name: name.trim(),
      ...(picture ? { picture } : {}),
      ...(config !== undefined ? { config } : {}),
    };
    try {
      if (update) await update.onSave(input);
      else onCreated(await (onCreate ? onCreate(input) : agents.create(input)));
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  const back = avatarActive
    ? () => avatarNavigation.current?.back()
    : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
      title={edited ? `Edit ${edited.name}` : "Create agent"}
      description={
        update
          ? `${update.request.requesterName} proposed these changes. Nothing changes until you save.`
          : request
            ? `${request.requesterName} requested this agent. Review its settings before creating it.`
            : undefined
      }
      size="wide"
      height="stable-tall"
      chromeSpacing="padded"
      bodyLayout={avatarActive ? "flex" : "flow"}
      initialFocus={nameField}
      // A started draft only closes from the close button.
      dismissOnOutsideClick={!dirty}
      onEscape={() => {
        if (back) {
          back();
          return true;
        }
        return dirty || pending;
      }}
      preventClose={pending}
      leadingActions={
        back && (
          <Button disabled={pending} onClick={back}>
            Back
          </Button>
        )
      }
      actions={
        <>
          <div ref={setAvatarAction} hidden={!avatarActive} />
          {!avatarActive && (
            <Button
              variant="primary"
              // The footer is outside the form; Enter in any field submits it.
              type="submit"
              form={form}
              loading={pending}
              disabled={avatarBusy || !type || pending}
            >
              {update ? "Save changes" : "Create agent"}
            </Button>
          )}
        </>
      }
    >
      <form
        id={form}
        className={styles.form}
        data-avatar-active={avatarActive || undefined}
        aria-label={edited ? `Edit ${edited.name}` : "New agent"}
        onSubmit={(event) => {
          event.preventDefault();
          if (!avatarActive) void create();
        }}
      >
        <AgentCreateHeader
          name={name}
          picture={picture}
          disabled={pending}
          community={community}
          onBusyChange={setAvatarBusy}
          onChange={(patch) => {
            if (patch.name !== undefined) {
              setName(patch.name);
              namePrompt.named(patch.name);
            }
            if (patch.picture !== undefined) setPicture(patch.picture);
            setDirty(true);
            setError("");
          }}
          nameRef={nameField}
          nameError={
            namePrompt.attempts
              ? {
                  message: update
                    ? "Name the agent"
                    : "Add a name to create your agent",
                  attempt: namePrompt.attempts,
                }
              : undefined
          }
          details={null}
          editing={false}
          avatarNavigationRef={avatarNavigation}
          avatarActionTarget={avatarAction}
          onAvatarActiveChange={setAvatarActive}
        />

        <div hidden={avatarActive} className="grid gap-4">
          <div className={styles.setupSurface}>
            <SettingsGroup>
              <PreferenceRow
                title="Harness"
                trailing={
                  <Select
                    label="Harness"
                    variant="compact"
                    align="end"
                    value={type?.key ?? ""}
                    disabled={pending || types.length < 2}
                    groups={[
                      {
                        label: "",
                        options: types.map((item) => ({
                          value: item.key,
                          label: item.remote
                            ? `${item.title} (hosted)`
                            : item.title,
                        })),
                      },
                    ]}
                    onValueChange={choose}
                  />
                }
              />
              {Model && (
                <PreferenceRow
                  title="Model"
                  trailing={
                    <Model
                      key={type.key}
                      config={config}
                      disabled={pending}
                      onChange={(next) => chooseModel(type, next)}
                    />
                  }
                />
              )}
            </SettingsGroup>
          </div>
          {preview && type && (
            <MigrationPreview
              source={types.find((item) => item.key === edited?.type)}
              target={type}
              preview={preview}
              discardDraft={false}
            />
          )}
          {Create ? (
            <Create
              key={type.key}
              config={config}
              disabled={pending}
              onChange={(next) => {
                setConfig(next);
                setDirty(true);
              }}
            />
          ) : (
            <p className="m-0 text-body-sm text-secondary">
              {type?.remote
                ? "Its provider keeps its key and runs it, whether or not this app is open."
                : "Set it up after it is made."}
            </p>
          )}
        </div>
        {error && (
          <p
            key={error}
            ref={reveal}
            role="alert"
            className="m-0 text-body-sm text-danger"
          >
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
