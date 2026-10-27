import { useProfileMessage } from "../../features/profiles/useProfileMessage";
import { AgentDetails } from "../agents/AgentDetails";
import { AgentMessageButton } from "../agents/AgentMessageButton";
import { useAgents } from "../../features/agents/react";
import {
  usePanelTabHost,
  usePanelTabTitle,
} from "../../features/panels/PanelWorkspace";
import { useAgentOwnerEvidence } from "../../features/profiles/useAgentOwnerEvidence";
import { UserStatusDisplay } from "../../features/user-status/StatusDisplay";
import { ProfilePublicMetadata } from "./ProfilePublicMetadata";
import { relayOrigin } from "../../features/communities/destination";
import type { Navigation } from "../../features/navigation/controller";
import { ProfileChannels } from "./ProfileChannels";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { usePresenceStatus } from "../../features/presence/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CopyIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { Button } from "../../shared/design-system/ui/Button";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import type { PanelProps } from "../../features/panels/service";
import {
  profileActivityViewKey,
  profileAgentHint,
  profilePanelKey,
  profileTarget,
} from "../../features/profiles/target";
import { formatPublicKey } from "../../shared/identity/public-key";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ProfileAgentIdentity } from "./ProfileAgentIdentity";
import styles from "./Profiles.module.css";
import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import hero from "../../features/profiles/ProfileHero.module.css";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { AgentDelete } from "../../features/agents/AgentManage";
import { useAgent, useChannelChoices } from "../../features/agents/react";
import type { Agents } from "../../features/agents/service";
import type { CommunityReader } from "../../features/communities/service";
import { agentSections } from "../../features/agents/tabs";
import { useAgentSettingsHost } from "../agents/AgentSettingsHost";
import { avatarMedia } from "../../shared/avatar-source";

const noSubscribe = () => () => {};
const emptyAgentTypes = Object.freeze([]);

export function ProfilePanel({
  relay,
  target,
  context,
  navigation,
  agents,
  communities,
  close,
}: PanelProps & {
  relay: RelayData;
  navigation?: Navigation;
  /** Agents show their type's tabs. */
  agents?: Agents;
  communities?: CommunityReader | undefined;
}) {
  const connection = useRelayConnection(relay);
  const activityKey = profileActivityViewKey(target);
  const pubkey = profilePanelKey(target) ?? activityKey;
  const owned = useAgent(agents, pubkey ?? "");
  if (!pubkey) return <p>Unsupported profile.</p>;
  if (connection.status !== "ready")
    return <p>Connect to a community to view this profile.</p>;
  if (
    agents &&
    owned &&
    owned.agent.owner === connection.viewer &&
    !owned.agent.unfinished &&
    owned.agent.place !== "elsewhere"
  )
    return (
      <OwnedAgentProfile
        key={`${connection.scope}:${connection.generation}:${pubkey}:${activityKey ? "activity" : "info"}`}
        agents={agents}
        communities={communities}
        initialActivity={!!activityKey}
        pubkey={pubkey}
        relay={relay}
        session={connection.session}
        navigation={navigation}
        context={context}
        close={close}
      />
    );
  return (
    <ProfileDetails
      key={`${connection.scope}:${connection.generation}:${pubkey}:${activityKey ? "activity" : "info"}`}
      initialTab={activityKey ? "activity" : "info"}
      session={connection.session}
      pubkey={pubkey}
      agentHint={profileAgentHint(target) || !!activityKey}
      context={context}
      navigation={navigation}
      agents={agents}
      communities={communities}
      scope={connection.scope}
      viewer={connection.viewer}
      close={close}
    />
  );
}
function OwnedAgentProfile({
  agents,
  communities,
  initialActivity,
  pubkey,
  relay,
  session,
  navigation,
  context,
  close,
}: {
  agents: Agents;
  communities: CommunityReader | undefined;
  initialActivity: boolean;
  pubkey: string;
  relay: RelayData;
  session: RelaySession;
  navigation: Navigation | undefined;
  context: PanelProps["context"];
  close(): void;
}) {
  const { types } = useAgents(agents);
  const owned = useAgent(agents, pubkey);
  const channels = useChannelChoices(session.channels);
  if (!owned) return null;
  return (
    <AgentDetails
      agents={agents}
      communities={communities}
      agent={owned.agent}
      type={owned.type}
      types={types}
      channels={channels}
      memories={session.agentMemories}
      onRemoved={close}
      initialActivity={initialActivity}
      conversation={
        context && {
          channelId: context.channelId,
          ...(context.rootId && { rootId: context.rootId }),
        }
      }
      messageAction={(variant) => (
        <AgentMessageButton
          variant={variant}
          pubkey={pubkey}
          relay={relay}
          navigator={navigation}
          navigation={undefined}
        />
      )}
    />
  );
}

function ProfileDetails({
  initialTab,
  agentHint,
  session,
  pubkey,
  context,
  navigation,
  agents,
  communities,
  scope,
  viewer,
  close,
}: {
  agents: Agents | undefined;
  communities: CommunityReader | undefined;
  initialTab: "info" | "activity";
  agentHint: boolean;
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
  navigation: Navigation | undefined;
  scope: string | undefined;
  viewer: string | undefined;
  close(): void;
}) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [pubkey]),
    [session.profiles, pubkey],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const profile = profiles.get(pubkey);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, retry] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const [tab, setTab] = useState<
    "info" | "activity" | "channels" | `agent:${string}`
  >(initialTab);
  // An agent's sections come from its type and the app, not the harness.
  const plugin = useAgent(agents, pubkey);
  const agentTypes = useSyncExternalStore(
    agents?.subscribe ?? noSubscribe,
    agents?.types ?? (() => emptyAgentTypes),
    () => emptyAgentTypes,
  );
  const settings = useAgentSettingsHost({
    agents,
    agent: plugin?.agent,
    type: plugin?.type,
    types: agentTypes,
  });
  const channelChoices = useChannelChoices(
    plugin ? session.channels : undefined,
  );
  const sections =
    settings.agent && agents
      ? agentSections({
          agents,
          agent: settings.agent,
          type: settings.type,
          channels: channelChoices,
          memories: session.agentMemories,
          communities,
          conversation: context && {
            channelId: context.channelId,
            ...(context.rootId && { rootId: context.rootId }),
          },
          ...(settings.settingsHost
            ? { settingsHost: settings.settingsHost }
            : {}),
        })
      : [];
  // Opened for activity, an agent shows its type's Activity tab (its
  // sessions), or its first tab when its type has none.
  const typeActivity = sections.find((item) => item.value === "agent:activity");
  const requestedTab =
    tab === "activity" ? ((typeActivity ?? sections[0])?.value ?? "info") : tab;
  const section = sections.find((item) => item.value === requestedTab);
  const tabHost = usePanelTabHost();
  const tabbed = !!tabHost;
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!tabbed) region.current?.focus();
  }, [tabbed]);
  // Each target/session owns this completion; shared data work remains session-owned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery.
  useEffect(() => {
    let active = true;
    setStatus("loading");
    void session.profiles.ensure([pubkey]).then(
      () => {
        if (active) setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [session, pubkey, attempt]);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const presence = usePresenceStatus(session.presence, pubkey, true);
  const knownAgent = agentPubkeys.has(pubkey);
  // Navigation can conservatively identify an agent; it grants no private control.
  const displayAgent = knownAgent || agentHint;
  const ownership = useAgentOwnerEvidence(
    session,
    knownAgent ? pubkey : undefined,
    attempt,
  );
  const verifiedOwner = ownership.owner;
  const selectedTab =
    requestedTab.startsWith("agent:") && !section ? "info" : requestedTab;
  let communityOrigin: string | undefined;
  if (scope && viewer && scope.endsWith(`:${viewer}`)) {
    try {
      communityOrigin = relayOrigin(scope.slice(0, -(viewer.length + 1)));
    } catch {
      // This session has no usable navigation scope.
    }
  }
  const npub = profileTarget(pubkey)?.slice(6) ?? pubkey;
  const identityName = useChannelIdentityNames(session, context?.channelId);
  const name = identityName(
    pubkey,
    profile?.name ??
      (displayAgent ? "Unknown agent" : (formatPublicKey(pubkey) ?? pubkey)),
  );
  // The portrait is 5rem (at most 240 device px), so the relay's 320 px
  // thumbnail already covers it and reuses the URL message rows have loaded.
  const picture = avatarMedia(profile?.picture, session.media) ?? null;
  const tabAvatar = useMemo(
    () => (
      <Avatar
        src={picture}
        alt=""
        fallback={name}
        size="fill"
        shape={knownAgent ? "squircle" : "circle"}
      />
    ),
    [picture, name, knownAgent],
  );
  usePanelTabTitle(name, tabAvatar);
  const {
    available: canMessage,
    opening: openingMessage,
    error: messageError,
    open: openMessage,
  } = useProfileMessage({
    session,
    pubkey,
    viewer,
    agent: displayAgent,
    enabled: !!navigation && !!communityOrigin,
    onOpened(channelId) {
      if (navigation && viewer && communityOrigin)
        void navigation.open({
          version: 1,
          kind: "conversation",
          channelId,
          scope: { viewer, communityOrigin },
        });
    },
  });

  return (
    <section
      ref={region}
      data-buzz-ui=""
      aria-label="Profile details"
      tabIndex={-1}
      className={styles.root}
    >
      <div className={styles.profileContents}>
        <div className={`${hero.hero} ${hero.panelHero}`}>
          <ProfileBackdrop src={picture} />
          <div className={styles.portrait}>
            <AgentAvatar
              session={session}
              agentPubkey={pubkey}
              channelId={context?.channelId}
              src={picture}
              alt={`${name} avatar`}
              fallback={name}
              size="fill"
              shape={displayAgent ? "squircle" : "circle"}
              statusBadge={presence === "unknown" ? undefined : presence}
            />
          </div>
          <div className={styles.identity}>
            <h2 className="text-body-lg">{name}</h2>
            {presence !== "unknown" && (
              <p className="text-body-sm text-primary">
                {
                  { online: "Active", away: "Away", offline: "Offline" }[
                    presence
                  ]
                }
              </p>
            )}
            <UserStatusDisplay session={session} userId={pubkey} />
          </div>
          {canMessage && (
            <div className={hero.actions}>
              <Button
                size="sm"
                variant={picture ? "glass" : "subtle"}
                loading={openingMessage}
                onClick={() => void openMessage()}
              >
                Message
              </Button>
            </div>
          )}
          {messageError && (
            <p role="alert" className="text-body-sm text-danger">
              {messageError}
            </p>
          )}
        </div>
        <Tabs
          value={selectedTab}
          onValueChange={setTab}
          items={[
            { value: "info", label: "Info" },
            ...sections.map(({ value, label }) => ({ value, label })),
            { value: "channels", label: "Channels" },
          ]}
          label="Profile sections"
          variant="panel"
          renderPanel={(selected) => (
            <div className={styles.tabContent}>
              {selected.startsWith("agent:") ? (
                sections.find((item) => item.value === selected)?.render()
              ) : selected === "info" ? (
                <>
                  {profile?.about && (
                    <SettingsGroup layout="form">
                      <p className={styles.about}>{profile.about}</p>
                    </SettingsGroup>
                  )}
                  {plugin && agents && plugin.agent.place !== "elsewhere" && (
                    <div>
                      <AgentDelete
                        agents={agents}
                        agent={plugin.agent}
                        onRemoved={close}
                      />
                    </div>
                  )}
                  <div className={styles.publicKey}>
                    <SettingsGroup>
                      <PreferenceRow
                        title="Public key"
                        subtitle={
                          <code className={styles.keyValue}>{npub}</code>
                        }
                        trailing={
                          <Button
                            size="compact"
                            variant="ghost"
                            aria-label="Copy npub"
                            onClick={() => {
                              setCopyStatus("");
                              void Promise.resolve()
                                .then(() => navigator.clipboard.writeText(npub))
                                .then(
                                  () => setCopyStatus("Public key copied."),
                                  () =>
                                    setCopyStatus(
                                      "Could not copy. Select the public key above to copy it.",
                                    ),
                                );
                            }}
                          >
                            <CopyIcon size={16} aria-hidden="true" />
                            Copy
                          </Button>
                        }
                      />
                    </SettingsGroup>
                    <span role="status" className={styles.feedback}>
                      {copyStatus}
                    </span>
                  </div>
                  {knownAgent && verifiedOwner && (
                    <ProfileAgentIdentity
                      session={session}
                      owner={verifiedOwner}
                      viewer={viewer}
                      context={context}
                    />
                  )}
                  <ProfilePublicMetadata nip05={profile?.nip05} />
                  {!profile &&
                    (status === "loading" ? (
                      <p role="status">Loading profile…</p>
                    ) : (
                      <p role={status === "error" ? "alert" : undefined}>
                        {status === "error"
                          ? "Could not load this profile."
                          : "No profile metadata is available in this community."}
                      </p>
                    ))}
                  {((!profile && status !== "loading") || ownership.failed) && (
                    <Button
                      size="compact"
                      onClick={() => retry((value) => value + 1)}
                    >
                      Retry profile
                    </Button>
                  )}
                </>
              ) : (
                <ProfileChannels
                  session={session}
                  pubkey={pubkey}
                  navigation={navigation}
                  communityOrigin={communityOrigin}
                  viewer={viewer}
                />
              )}
            </div>
          )}
        />
      </div>
    </section>
  );
}
