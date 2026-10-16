import { motion, useReducedMotion } from "motion/react";
import { Input } from "../../shared/design-system/ui/Input";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  usePanelTabHost,
  usePanelTabTitle,
} from "../../features/panels/PanelWorkspace";
import { AgentSaveFooter } from "../../features/agents/AgentSaveButton";
import type { ChannelChoice } from "../../features/agents/attention";
import type { AgentMemories } from "../../features/agents/MemoryPanel";
import type {
  Agent,
  Agents,
  AgentConversation,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  AgentArchiveRetry,
  AgentDelete,
} from "../../features/agents/AgentManage";
import {
  CopyIcon,
  DotsThreeIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  canonicalPublicKey,
  formatPublicKey,
} from "../../shared/identity/public-key";
import { AgentPortrait } from "./AgentCard";
import { AgentIdentityDialog } from "./AgentIdentityDialog";
import { AgentTabs } from "./AgentTabs";
import { useAgentSettingsHost } from "./AgentSettingsHost";
import styles from "./AgentsPage.module.css";

export function AgentDetails({
  agents,
  agent,
  type,
  types,
  channels,
  memories,
  onRemoved,
  messageAction,
  conversation,
  initialActivity,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  types: readonly RegisteredAgentType[];
  channels: readonly ChannelChoice[];
  memories: AgentMemories | undefined;
  onRemoved(): void;
  messageAction: ReactNode;
  conversation?: AgentConversation | undefined;
  initialActivity?: boolean;
}) {
  const tabbed = !!usePanelTabHost();
  const reducedMotion = useReducedMotion();
  const identityTransition = {
    duration:
      reducedMotion ||
      document.documentElement.hasAttribute("data-keyboard-navigation")
        ? 0
        : 0.22,
    ease: [0.23, 1, 0.32, 1] as const,
  };
  const tabAvatar = useMemo(
    () => (
      <span aria-hidden="true" className="block h-full w-full">
        <AgentPortrait agent={agent} community={agent.relay} />
      </span>
    ),
    [agent],
  );
  usePanelTabTitle(agent.name, tabAvatar);
  const [saveFooter, setSaveFooter] = useState<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Completing setup removes its focused button; continue in Identity.
    if (document.activeElement === document.body)
      content.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
  }, []);
  const [copied, setCopied] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const identityMenu = useRef<HTMLButtonElement>(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(agent.name);
  const [namePending, setNamePending] = useState(false);
  const [nameError, setNameError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editingName) return;
    // Wait for the closing menu's focus handoff before placing the caret.
    const frame = requestAnimationFrame(() => {
      const input = nameInput.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [editingName]);
  const finishName = () => {
    setEditingName(false);
    requestAnimationFrame(() => identityMenu.current?.focus());
  };
  const saveName = async () => {
    if (namePending || !name.trim()) return;
    setNamePending(true);
    setNameError("");
    try {
      await agents.save(agent.pubkey, { name: name.trim() });
      finishName();
    } catch (reason) {
      setNameError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNamePending(false);
    }
  };
  const openIdentity = (target: "name" | "avatar") => {
    if (target === "avatar") setEditingIdentity(true);
    else {
      setName(agent.name);
      setNameError("");
      setEditingName(true);
    }
  };
  const [copyError, setCopyError] = useState("");
  const npub = canonicalPublicKey(agent.pubkey);
  const settings = useAgentSettingsHost({ agents, agent, type, types });
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <AgentSaveFooter value={saveFooter}>
      <div className={styles.build}>
        <div ref={content} className={styles.detailsScroll}>
          {!tabbed && (
            <IconButton
              aria-label="Close"
              size="sm"
              icon={<XIcon size={16} />}
              onClick={onRemoved}
            />
          )}
          <aside className={styles.rail} aria-label={`${agent.name} identity`}>
            <motion.div
              className={styles.identityPortrait}
              initial={false}
              animate={{
                scale: editingName ? 0.55 : 1,
                y: editingName ? "-1.8rem" : "0rem",
              }}
              transition={identityTransition}
            >
              <AgentPortrait agent={agent} community={agent.relay} />
            </motion.div>
            <motion.div
              className={styles.identityName}
              initial={false}
              animate={{
                scale: editingName ? 1.3 : 1,
                y: editingName ? "-1.8rem" : "0rem",
              }}
              transition={identityTransition}
            >
              <h2
                className="m-0 text-heading text-center break-words"
                style={{ visibility: editingName ? "hidden" : undefined }}
              >
                {agent.name}
              </h2>
              {editingName && (
                <div className={styles.nameEditor}>
                  <Input
                    appearance="heading"
                    ref={nameInput}
                    aria-label="Agent name"
                    value={name}
                    disabled={namePending}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveName();
                      }
                      if (event.key === "Escape" && !namePending) {
                        event.preventDefault();
                        event.stopPropagation();
                        finishName();
                      }
                    }}
                  />
                </div>
              )}
            </motion.div>
            <div className={styles.identityActions}>
              {editingName ? (
                <motion.div
                  className={styles.nameActions}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{
                    duration:
                      reducedMotion ||
                      document.documentElement.hasAttribute(
                        "data-keyboard-navigation",
                      )
                        ? 0
                        : 0.15,
                  }}
                >
                  <Button
                    size="sm"
                    shape="control"
                    disabled={namePending}
                    onClick={finishName}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    shape="control"
                    variant="prominent"
                    loading={namePending}
                    disabled={!name.trim()}
                    onClick={() => void saveName()}
                  >
                    Save
                  </Button>
                </motion.div>
              ) : (
                <>
                  {messageAction}
                  <MenuRoot>
                    <MenuTrigger
                      render={
                        <IconButton
                          ref={identityMenu}
                          aria-label="Agent profile actions"
                          variant="subtle"
                          size="sm"
                          icon={<DotsThreeIcon aria-hidden="true" />}
                        />
                      }
                    />
                    <MenuPopup
                      align="end"
                      finalFocus={() =>
                        nameInput.current ?? identityMenu.current ?? false
                      }
                    >
                      <MenuItem onClick={() => openIdentity("avatar")}>
                        Change avatar
                      </MenuItem>
                      <MenuItem onClick={() => openIdentity("name")}>
                        Change name
                      </MenuItem>
                    </MenuPopup>
                  </MenuRoot>
                </>
              )}
            </div>
            {editingName && nameError && (
              <p role="alert" className="m-0 text-body-sm text-danger">
                {nameError}
              </p>
            )}
            {editingIdentity && (
              <AgentIdentityDialog
                agent={agent}
                agents={agents}
                finalFocus={identityMenu}
                initialAvatarPicker
                onClose={() => setEditingIdentity(false)}
              />
            )}
          </aside>
          <section
            className={styles.work}
            aria-label={`${agent.name} settings`}
          >
            {!type && (
              <p className="m-0 mb-4 text-body-sm text-secondary">
                Enable the plugin that provides this agent's type to change its
                settings. Its attention can still be edited.
              </p>
            )}
            <AgentTabs
              agents={agents}
              agent={settings.agent}
              type={settings.type}
              channels={channels}
              conversation={conversation}
              initialActivity={initialActivity}
              settingsHost={settings.settingsHost}
              memories={memories}
              settingsContent={
                <div>
                  <InlineHeader title="Agent details" level={4} />
                  <SettingsGroup>
                    <PreferenceRow
                      title="Public key"
                      subtitle={
                        <code title={npub}>
                          {formatPublicKey(agent.pubkey, 8)}
                        </code>
                      }
                      trailing={
                        <IconButton
                          aria-label={copied ? "Copied" : "Copy public key"}
                          size="sm"
                          icon={<CopyIcon size={16} aria-hidden="true" />}
                          disabled={!npub}
                          onClick={() => {
                            if (!npub) return;
                            setCopyError("");
                            void Promise.resolve()
                              .then(() => navigator.clipboard.writeText(npub))
                              .then(() => setCopied(true))
                              .catch(() =>
                                setCopyError(
                                  "Could not copy the public key. Try again.",
                                ),
                              );
                          }}
                        />
                      }
                    />
                    <AgentArchiveRetry agents={agents} agent={agent} />
                    <PreferenceRow
                      title="Delete agent"
                      subtitle={
                        agent.deleting &&
                        "Its Delete didn't finish, so it stays stopped. Delete it again to finish."
                      }
                      trailing={
                        <AgentDelete
                          agents={agents}
                          agent={agent}
                          onRemoved={onRemoved}
                          trigger={(open) => (
                            <Button
                              size="compact"
                              variant="destructive"
                              aria-label="Delete agent"
                              onClick={open}
                            >
                              Delete
                            </Button>
                          )}
                        />
                      }
                    />
                  </SettingsGroup>
                  {copyError && (
                    <p role="alert" className="mt-2 text-body-sm text-danger">
                      {copyError}
                    </p>
                  )}
                </div>
              }
            />
          </section>
        </div>
        <div ref={setSaveFooter} className={styles.saveFooter} />
      </div>
    </AgentSaveFooter>
  );
}
