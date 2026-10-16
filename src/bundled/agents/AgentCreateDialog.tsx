// Agent identity above the type-owned model and instructions fields.
import { useId, useRef, useState } from "react";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { RobotIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { AgentCreateHeader } from "./AgentCreateHeader";
import styles from "./AgentCreate.module.css";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

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
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  community?: string | undefined;
  onClose(): void;
  onCreated(agent: Agent): void;
}) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("");
  const [picture, setPicture] = useState(() => randomAgentAvatar().url);
  const [typeKey, setTypeKey] = useState(types[0]?.key ?? "");
  const type = types.find((item) => item.key === typeKey) ?? types[0];
  const [config, setConfig] = useState(() => startingConfig(type));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [avatarActive, setAvatarActive] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarAction, setAvatarAction] = useState<HTMLDivElement | null>(null);
  const avatarNavigation = useRef<{ back(): void }>(null);
  const nameField = useRef<HTMLInputElement>(null);
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
    if (item && key !== type?.key) chooseModel(item, startingConfig(item));
  };
  const create = async () => {
    if (!type || !name.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      const agent = await agents.create({
        type: type.key,
        name: name.trim(),
        ...(picture ? { picture } : {}),
        ...(config !== undefined ? { config } : {}),
      });
      onCreated(agent);
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
      title="Create agent"
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
            // Stays mounted while the name changes so the button keeps its node.
            <Tooltip
              content="Add a name first"
              disableHoverablePopup
              {...(name.trim() ? { open: false } : {})}
            >
              <Button
                variant="primary"
                // The footer is outside the form; Enter in any field submits it.
                type="submit"
                form={form}
                loading={pending}
                disabled={avatarBusy || !type || !name.trim() || pending}
                focusableWhenDisabled={!name.trim()}
              >
                Create agent
              </Button>
            </Tooltip>
          )}
        </>
      }
    >
      <form
        id={form}
        className={styles.form}
        data-avatar-active={avatarActive || undefined}
        aria-label="New agent"
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
            if (patch.name !== undefined) setName(patch.name);
            if (patch.picture !== undefined) setPicture(patch.picture);
            setDirty(true);
            setError("");
          }}
          nameRef={nameField}
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
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
