import { workflowLabel } from "../../features/relay/workflow-attribution";
import { useIdentityNames } from "../../features/identity-names/react";
import { npubEncode } from "nostr-tools/nip19";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList } from "../../features/relay/react";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useMentionArchives } from "../../features/messages/use-mention-archives";
import { archiveHides } from "../../features/relay/identity-archives";
import { foldProfiles } from "../../features/relay/profiles";
import {
  CalendarIcon,
  ChatCircleIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import type { SearchDestination, SearchInputProps } from "./SearchChoices";
import { SearchChoices } from "./SearchChoices";
import { matchName, matchRank } from "../../features/search/match";
import {
  noSearchUsage,
  readSearchUsage,
  recordChoice,
  searchOrder,
} from "../../features/search/usage";
import { usePublicChannelSearch } from "../../features/channels/usePublicChannelSearch";
import { useSearchMessages } from "./useSearchMessages";
import { matchPerson } from "../../features/search/person-match";
import {
  personKey,
  rankPeople,
  type PersonCandidate,
} from "../../features/search/people-rank";
import { peopleRelationships } from "../../features/profiles/relationships";
import { knownAgentPubkeys } from "../../features/agents/known";
import { usePersonDirectory } from "./usePersonDirectory";
import {
  isChannelUuid,
  isHexPubkey,
  normalizeInChannel,
  parseSearchOperators,
} from "./parseSearchOperators";
import { avatarMedia } from "../../shared/avatar-source";

function conversationName(
  channel: ChannelSummary,
  profiles: ReadonlyMap<string, Profile>,
  resolveName: ReturnType<typeof useIdentityNames>,
) {
  if (channel.channelType !== "dm" || !channel.participants)
    return channel.name;
  return (
    channel.participants
      .map((id) =>
        resolveName(
          id,
          profiles.get(id)?.name ?? id.slice(0, 10),
          channel.participants,
        ),
      )
      .join(", ") || "Notes to self"
  );
}

/** The most rows the People and Agents groups each show. */
const PERSON_ROWS = 6;

export function SearchResults({
  session,
  query,
  onQueryChange,
  input,
  pages,
  scopedChannelId,
  currentChannelId,
  onScopeChange,
  openConversation,
  openAgentSession,
  usageScope,
}: {
  session: RelaySession;
  pages: readonly SearchDestination[];
  scopedChannelId?: string | undefined;
  currentChannelId?: string | undefined;
  onScopeChange?: ((channelId?: string) => void) | undefined;
  openConversation: (channelId: string, messageId?: string) => void;
  /** Open a new Solo chat with one of the viewer's agents. Without it,
   * choosing one of their agents opens a direct message, as for anyone else. */
  openAgentSession?: ((pubkey: string) => void) | undefined;
  /** View-state partition whose visits and search choices rank results. */
  usageScope?: string | undefined;
} & SearchInputProps) {
  const resolveName = useIdentityNames(session.names);
  const list = useChannelList(session.channels);
  const parsed = useMemo(() => parseSearchOperators(query.trim()), [query]);
  const authorPrompt = /(?:^|\s)from:(@?)([^\s]*)$/i.exec(query);
  const pickerPrompt = !!authorPrompt && !isHexPubkey(authorPrompt[2] ?? "");
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const channels = useMemo(
    () =>
      list.channels.filter(
        (channel) =>
          (!channel.archived ||
            (!channel.readOnly &&
              (channel.channelType === "stream" ||
                channel.channelType === "forum" ||
                channel.channelType === "solo"))) &&
          (!channel.hidden || channel.channelType === "dm") &&
          (!scopedChannelId || channel.id === scopedChannelId),
      ),
    [list.channels, scopedChannelId],
  );
  const [selectedAuthor, setSelectedAuthor] = useState<{
    query: string;
    pubkey: string;
    name: string;
    index: number;
  }>();
  const authorOperand = selectedAuthor ? `from:${selectedAuthor.pubkey}` : "";
  const selectedIndex = selectedAuthor?.index ?? -1;
  const showAuthorChip =
    !!selectedAuthor &&
    query === selectedAuthor.query &&
    query.slice(selectedIndex, selectedIndex + authorOperand.length) ===
      authorOperand;
  const displayQuery = showAuthorChip
    ? `${query.slice(0, selectedIndex)}${query.slice(selectedIndex + authorOperand.length).replace(/^\s/, "")}`
    : undefined;
  const updateDisplayQuery = (value: string) => {
    const nextQuery = showAuthorChip
      ? `from:${selectedAuthor?.pubkey} ${value.trimStart()}`
      : value;
    setSelectedAuthor(
      showAuthorChip && selectedAuthor
        ? { ...selectedAuthor, query: nextQuery, index: 0 }
        : undefined,
    );
    onQueryChange(nextQuery);
  };
  const removeSelectedAuthor = () => {
    if (!selectedAuthor || !showAuthorChip) return;
    onQueryChange(displayQuery ?? "");
    setSelectedAuthor(undefined);
    input.current?.focus();
  };
  const updateDateQuery = (nextQuery: string) => {
    if (showAuthorChip && selectedAuthor) {
      const index = nextQuery.indexOf(authorOperand);
      setSelectedAuthor(
        index < 0 ? undefined : { ...selectedAuthor, query: nextQuery, index },
      );
    }
    onQueryChange(nextQuery);
  };
  const [authorSuggestions, setAuthorSuggestions] = useState<{
    query: string;
    lookupFailed?: boolean;
    remote: readonly EventData[];
  }>();
  // Completing either from:name or from:@name selects an exact signed key.
  const datePrompt = /(?:^|\s)(after|before):([^\s]*)$/i.exec(query);
  const showDateChoices =
    !!datePrompt && !/^\d{4}-\d{2}-\d{2}$/.test(datePrompt[2] ?? "");
  const datePresets = [
    ["Today", 0],
    ["Yesterday", 1],
    ["This week", 2],
    ["Last week", 3],
    ["This month", 4],
  ] as const;
  const dateChoices: SearchDestination[] =
    showDateChoices && datePrompt
      ? datePresets.map(([label, kind]) => {
          const day = new Date();
          day.setHours(0, 0, 0, 0);
          if (kind === 1) day.setDate(day.getDate() - 1);
          if (kind === 2 || kind === 3) {
            day.setDate(
              day.getDate() - ((day.getDay() + 6) % 7) - (kind === 3 ? 7 : 0),
            );
          }
          if (kind === 4) day.setDate(1);
          const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
          return {
            key: `date:${kind}`,
            label,
            detail: date,
            icon: CalendarIcon,
            run: () =>
              updateDateQuery(
                `${query.slice(0, datePrompt.index)} ${datePrompt[1]}:${date} `.trimStart(),
              ),
          };
        })
      : [];
  const names = new Map(
    channels.map((channel) => [
      channel.id,
      conversationName(channel, profiles, resolveName),
    ]),
  );
  const operatorChannel = parsed.in ? normalizeInChannel(parsed.in) : "";
  const localChannel = operatorChannel
    ? list.channels.find(
        (channel) =>
          channel.name.toLowerCase() === operatorChannel.toLowerCase() ||
          names.get(channel.id)?.toLowerCase() ===
            operatorChannel.toLowerCase(),
      )
    : undefined;
  const needsPublicLookup =
    !scopedChannelId &&
    !!operatorChannel &&
    !isChannelUuid(operatorChannel) &&
    !localChannel;
  const operatorPublicChannels = usePublicChannelSearch(
    session,
    needsPublicLookup ? operatorChannel : "",
    list.status === "ready",
    true,
  );
  const operatorChannelId = isChannelUuid(operatorChannel)
    ? operatorChannel
    : (localChannel?.id ?? operatorPublicChannels.channels[0]?.id);
  // The author picker also matches a selectable agent by its own name, so a
  // completed from: name resolves against the same names.
  const agentSnapshot = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const search = useSearchMessages(
    session,
    query,
    scopedChannelId,
    operatorChannelId,
    new Map(
      agentSnapshot.selectable
        .filter(
          (agent) =>
            !archiveHides(session.archives, agent.pubkey, session.viewer),
        )
        .map((agent) => [agent.pubkey, agent.name]),
    ),
  );
  const showAmbiguousPicker = !!search.ambiguousAuthor && !pickerPrompt;
  // Ambiguity is known only after a completed token. Keep its original span so
  // choosing a key does not discard free text or other operators after it.
  const completedAuthor = showAmbiguousPicker
    ? [...query.matchAll(/(?:^|\s)from:(@?)(\S+)/gi)].at(-1)
    : undefined;
  const authorToken = authorPrompt ?? completedAuthor;
  const authorNeedle = (authorPrompt?.[2] ?? parsed.from ?? "")
    .replace(/^@/, "")
    .toLowerCase();
  const showAuthorPicker = pickerPrompt || showAmbiguousPicker;
  const agents = useAgentChoices(session, showAuthorPicker);
  // People and agents are destinations for plain typed text outside a
  // conversation scope; an operator asks for messages. `@` asks for a person
  // and `#` for a channel.
  const peopleText = parsed.text.trim();
  const peopleNeedle = peopleText.replace(/^@/, "");
  const peopleActive =
    !scopedChannelId &&
    parsed.from === null &&
    parsed.in === null &&
    parsed.since === null &&
    parsed.until === null &&
    !showAuthorPicker &&
    !showDateChoices &&
    !!peopleNeedle &&
    !peopleText.startsWith("#");
  const personDirectory = usePersonDirectory(
    session,
    peopleNeedle,
    peopleActive,
  );
  useMentionArchives(session, showAuthorPicker || peopleActive);
  // The viewer's own agents open a new chat, not a direct message: the
  // same agents the new-chat composer accepts. Their earlier chats
  // still show as conversations.
  const sessionSearch = !!openAgentSession && peopleActive;
  const ownAgents = useAgentChoices(session, sessionSearch, sessionSearch);
  const sessionAgents = new Map(
    (sessionSearch ? ownAgents.selectable : []).map((agent) => [
      agent.pubkey,
      agent,
    ]),
  );
  const effectiveChannelId = scopedChannelId ?? operatorChannelId;
  useEffect(() => {
    if (!showAuthorPicker) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const members = effectiveChannelId
          ? (session.channels.get?.(effectiveChannelId)?.members ?? [])
          : [];
        if (members.length) {
          try {
            await session.profiles.ensure(members, "foreground");
          } catch (error) {
            if (controller.signal.aborted) throw error;
            // A partial directory still contains verified member profiles.
          }
        }
        let remote: readonly EventData[] = [];
        let lookupFailed = false;
        if (authorNeedle) {
          try {
            remote = await session.searchProfiles(authorNeedle, {
              limit: 40,
              signal: controller.signal,
            });
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lookupFailed = true;
          }
        }
        controller.signal.throwIfAborted();
        setAuthorSuggestions({ query, lookupFailed, remote });
      })().catch(() => {
        if (!controller.signal.aborted)
          setAuthorSuggestions({ query, remote: [], lookupFailed: true });
      });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, effectiveChannelId, query, authorNeedle, showAuthorPicker]);
  const members = effectiveChannelId
    ? (session.channels.get?.(effectiveChannelId)?.members ?? [])
    : [];
  const knownAgents = new Set(agents.identities.map(({ pubkey }) => pubkey));
  const selectableAgents = new Map(
    agents.selectable.map((agent) => [agent.pubkey, agent]),
  );
  const candidates = new Map([
    ...[...profiles].filter(([pubkey]) => members.includes(pubkey)),
    ...agents.selectable.map(
      (agent) =>
        [
          agent.pubkey,
          profiles.get(agent.pubkey) ?? {
            name: agent.name,
            isAgent: true as const,
            ...(agent.avatar ? { picture: agent.avatar } : {}),
          },
        ] as const,
    ),
    ...foldProfiles(
      authorSuggestions?.query === query ? authorSuggestions.remote : [],
    ),
  ]);
  // A selectable agent also matches by its own name, as in @ mentions.
  const authorTier = (pubkey: string, name: string) =>
    Math.min(
      ...[name, selectableAgents.get(pubkey)?.name].map((alias) =>
        alias === undefined
          ? Infinity
          : (matchPerson(alias, authorNeedle)?.tier ?? Infinity),
      ),
    );
  const authorChoices =
    authorToken && showAuthorPicker && authorSuggestions?.query === query
      ? [...candidates]
          .filter(([pubkey, profile]) => authorTier(pubkey, profile.name) < 4)
          .filter(
            ([pubkey]) =>
              !archiveHides(session.archives, pubkey, session.viewer) &&
              (!knownAgents.has(pubkey) || selectableAgents.has(pubkey)),
          )
          // Exact names survive the cap when the resolver reports ambiguity.
          .sort(
            ([left, leftProfile], [right, rightProfile]) =>
              Number(authorTier(right, rightProfile.name) === 0) -
                Number(authorTier(left, leftProfile.name) === 0) ||
              Number(!!leftProfile.isAgent || knownAgents.has(left)) -
                Number(!!rightProfile.isAgent || knownAgents.has(right)) ||
              Number(members.includes(right)) - Number(members.includes(left)),
          )
          .slice(0, 12)
          .map(([pubkey, profile]) => ({ pubkey, profile }))
          .map(({ pubkey, profile }) => {
            const agent = selectableAgents.get(pubkey);
            const isAgent = !!agent || !!profile.isAgent;
            return {
              key: `author:${pubkey}`,
              label: resolveName(
                pubkey,
                profile.name,
                effectiveChannelId
                  ? session.channels.get?.(effectiveChannelId)?.members
                  : undefined,
              ),
              detail: pubkey.slice(0, 12),
              icon: ChatCircleIcon,
              avatar: {
                src: avatarMedia(
                  profile.picture ?? agent?.avatar,
                  session.media,
                ),
                shape: isAgent ? ("squircle" as const) : ("circle" as const),
              },
              isAgent,
              run: () => {
                // The prompt's leading separator may be the one removed with
                // the old chip. Map the token itself through that removal,
                // rather than subtracting the separator from its start twice.
                const visible = displayQuery ?? query;
                const oldEnd = selectedIndex + authorOperand.length;
                const removedLength = showAuthorChip
                  ? authorOperand.length + (query[oldEnd] === " " ? 1 : 0)
                  : 0;
                const tokenStart =
                  authorToken.index +
                  (authorToken[0].match(/^\s*/)?.[0].length ?? 0);
                const promptStart =
                  showAuthorChip && selectedIndex < tokenStart
                    ? tokenStart - removedLength
                    : tokenStart;
                const promptEnd =
                  promptStart + authorToken[0].trimStart().length;
                const prefix = visible.slice(0, promptStart);
                const nextQuery = `${prefix}from:${pubkey}${visible.slice(promptEnd) || " "}`;
                setSelectedAuthor({
                  query: nextQuery,
                  pubkey,
                  name: profile.name,
                  index: prefix.length,
                });
                onQueryChange(nextQuery);
                input.current?.focus();
              },
            };
          })
      : [];
  const publicChannels = usePublicChannelSearch(
    session,
    scopedChannelId ? "" : parsed.text,
    list.status === "ready",
  );

  const profileKey = [
    ...new Set([
      ...channels.flatMap((channel) =>
        channel.channelType === "dm" ? (channel.participants ?? []) : [],
      ),
      ...search.messages.flatMap((message) => [
        message.authorId,
        ...(message.workflowOwnerId ? [message.workflowOwnerId] : []),
      ]),
    ]),
  ]
    .sort()
    .slice(0, 1024)
    .join(":");
  useEffect(() => {
    if (profileKey)
      void session.profiles
        .ensure(profileKey.split(":"), "background")
        .catch(() => {});
  }, [session, profileKey]);
  const needle = parsed.text.toLowerCase().replace(/^#/, "");
  // Read once per opening, so usage recorded while it is open cannot reorder it.
  const usage = useMemo(
    () => (usageScope ? readSearchUsage(usageScope) : noSearchUsage),
    [usageScope],
  );
  const choose = (key: string, run: () => void) => () => {
    if (usageScope) recordChoice(usageScope, needle, key);
    run();
  };
  const managedAgents = new Map(
    agents.identities
      .filter((agent) => agent.managed)
      .map((agent) => [agent.pubkey, agent]),
  );
  const people: (PersonCandidate & { picture?: string | undefined })[] = [];
  if (peopleActive) {
    const relationships = peopleRelationships(
      list.channels,
      new Set(managedAgents.keys()),
    );
    const knownAgents = knownAgentPubkeys(profiles, {
      definitions: [],
      identities: agents.identities,
    });
    const sources = new Map<
      string,
      {
        name: string;
        username?: string | undefined;
        picture?: string | undefined;
        isAgent?: boolean | undefined;
      }
    >();
    // Ties keep this order, as in New message: the directory's rows first, in
    // the relay's order, then cached profiles, then agents. A cached profile
    // still supplies a directory row's facts.
    const cached = (pubkey: string) => {
      const profile = profiles.get(pubkey);
      return profile && (!profile.nameIsFallback || profile.username)
        ? profile
        : undefined;
    };
    for (const person of personDirectory.people)
      sources.set(person.pubkey, cached(person.pubkey) ?? person);
    for (const [pubkey, profile] of profiles)
      if (!sources.has(pubkey) && cached(pubkey)) sources.set(pubkey, profile);
    for (const agent of [...managedAgents.values(), ...sessionAgents.values()])
      if (!sources.has(agent.pubkey))
        sources.set(agent.pubkey, {
          name: agent.name,
          picture: agent.avatar,
          isAgent: true,
        });
    const eligible = [...sources].flatMap(([pubkey, source]) => {
      const agent =
        !!source.isAgent ||
        knownAgents.has(pubkey) ||
        sessionAgents.has(pubkey);
      // As in New message, an agent is a destination only when this
      // community's native control manages it.
      return pubkey === session.viewer ||
        (agent && !managedAgents.has(pubkey) && !sessionAgents.has(pubkey)) ||
        archiveHides(session.archives, pubkey, session.viewer)
        ? []
        : [{ pubkey, source, agent }];
    });
    // Namesakes are told apart within these destinations. Directory rows are
    // not in the shared profile cache, so they supply their own names.
    const candidates = eligible.map(({ pubkey }) => pubkey);
    const displayFacts = personDirectory.people
      .filter((person) => sources.get(person.pubkey) === person)
      .map((person) => ({
        pubkey: person.pubkey,
        name: person.name,
        ...(person.isAgent ? { isAgent: true } : {}),
      }));
    for (const { pubkey, source, agent } of eligible) {
      const dm = relationships.dm(pubkey);
      const agentName =
        managedAgents.get(pubkey)?.name ?? sessionAgents.get(pubkey)?.name;
      people.push({
        pubkey,
        label: resolveName(pubkey, source.name, candidates, displayFacts),
        username: source.username,
        agentName: agentName !== source.name ? agentName : undefined,
        agent,
        relationship: relationships.rank(pubkey),
        usageKeys: [personKey(pubkey), ...(dm ? [`channel:${dm}`] : [])],
        picture:
          source.picture ??
          managedAgents.get(pubkey)?.avatar ??
          sessionAgents.get(pubkey)?.avatar,
      });
    }
  }
  // What the viewer chose before for this typed text. Only candidates that
  // match count, so a stale choice cannot add a row.
  const picked = usage.pick(
    needle,
    new Set([
      ...channels
        .filter(
          ({ id }) =>
            parsed.text && matchRank(names.get(id) ?? "", needle) !== undefined,
        )
        .map(({ id }) => `channel:${id}`),
      ...publicChannels.channels.map(({ id }) => `channel:${id}`),
      ...pages.map(({ key }) => key),
      ...people.map(({ pubkey }) => personKey(pubkey)),
    ]),
  );
  // Rank before the limit, so an exact name beyond the first eight still shows.
  // The relay matches public channels itself; keep its matches, ranked last.
  // The shared search order, with archived channels half a step behind live
  // ones in the same place.
  const rankOf = (label: string, key: string, archived?: boolean) => {
    const rank = matchRank(label, needle) ?? 6;
    return searchOrder(usage, picked, { key, rank }) + (archived ? 0.5 : 0);
  };
  const byMatch = <T,>(rows: readonly T[], rank: (row: T) => number) =>
    rows
      .map((row) => ({ row, rank: rank(row) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ row }) => row);
  const channelRank = (channel: ChannelSummary) =>
    rankOf(
      names.get(channel.id) ?? channel.name,
      `channel:${channel.id}`,
      channel.archived,
    );
  const matchingAll = byMatch(
    channels.filter(
      (channel) =>
        parsed.text &&
        matchRank(names.get(channel.id) ?? "", needle) !== undefined,
    ),
    channelRank,
  );
  // A DM with one of the viewer's own agents gives way to its "New chat"
  // row, but only when that row shows; the DM stays in the sidebar. Removing
  // DM-listed people below only lifts the rest, so a row shown here still
  // shows in the Agents group.
  const shownSessionAgents = new Set(
    rankPeople(
      people.filter(({ agent }) => agent),
      peopleNeedle,
      usage,
      picked,
    )
      .slice(0, PERSON_ROWS)
      .map(({ person }) => person.pubkey)
      .filter((pubkey) => sessionAgents.has(pubkey)),
  );
  const matchingChannels = matchingAll
    .filter(
      (channel) =>
        !(
          channel.channelType === "dm" &&
          channel.participants?.length === 1 &&
          shownSessionAgents.has(channel.participants[0] ?? "")
        ),
    )
    .slice(0, 8);
  const directMessageResults = matchingChannels.filter(
    (channel) => channel.channelType === "dm",
  );
  // A person whose DM row already shows needs no second row to the same place.
  const listedDms = new Set(
    directMessageResults.flatMap((channel) =>
      channel.participants?.length === 1 ? channel.participants : [],
    ),
  );
  const rankedPeople = rankPeople(
    people.filter(({ pubkey }) => !listedDms.has(pubkey)),
    peopleNeedle,
    usage,
    picked,
  );
  const joinedAll = matchingAll.filter(
    (channel) => channel.channelType !== "dm",
  );
  // Joined and public channels share one ranking before the limit, so the row
  // that gives the group its best rank, such as a remembered public channel,
  // is the row shown first. Joined channels win ties.
  const channelResults = byMatch(
    [
      ...joinedAll,
      ...publicChannels.channels.filter(
        (channel) => !joinedAll.some(({ id }) => id === channel.id),
      ),
    ],
    channelRank,
  ).slice(0, 8);
  const conversationDestination = (
    channel: ChannelSummary,
  ): SearchDestination => {
    const label = names.get(channel.id) ?? channel.name;
    const matches = needle ? matchName(label, needle)?.positions : undefined;
    const key = `channel:${channel.id}`;
    return {
      key,
      label,
      ...(matches ? { matches } : {}),
      detail: channel.archived
        ? "Archived channel"
        : channel.readOnly && !channel.cached
          ? "Public channel · not joined"
          : channel.channelType === "dm"
            ? "Direct message"
            : channel.channelType === "solo"
              ? "Chat"
              : "Conversation",
      icon: ChatCircleIcon,
      run: choose(key, () => openConversation(channel.id)),
    };
  };
  // Choosing a person opens your DM with them, starting it when needed.
  const [personOpen, setPersonOpen] = useState<{
    name: string;
    error?: string;
  }>();
  const personAttempt = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => personAttempt.current?.abort(), []);
  const openPerson = async (pubkey: string, name: string, agent: boolean) => {
    if (personAttempt.current) return;
    const existing = session.channels
      .list()
      .channels.find(
        (channel) =>
          channel.channelType === "dm" &&
          !channel.archived &&
          !channel.hidden &&
          channel.participants?.length === 1 &&
          channel.participants[0] === pubkey,
      );
    if (existing) return openConversation(existing.id);
    if (
      agent &&
      !session.agentChoices
        .snapshot()
        .identities.some((item) => item.managed && item.pubkey === pubkey)
    ) {
      setPersonOpen({
        name,
        error: "This agent is not ready to message in this community.",
      });
      return;
    }
    const controller = new AbortController();
    personAttempt.current = controller;
    setPersonOpen({ name });
    try {
      const channelId = await session.directMessages.open(
        [pubkey],
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPersonOpen(undefined);
      openConversation(channelId);
    } catch (reason) {
      if (!controller.signal.aborted)
        setPersonOpen({
          name,
          error:
            reason instanceof Error
              ? reason.message
              : "Could not open the conversation. Try again.",
        });
    } finally {
      if (personAttempt.current === controller)
        personAttempt.current = undefined;
    }
  };
  const personDestination = ({
    person,
    order,
  }: (typeof rankedPeople)[number]): SearchDestination & {
    order: number;
  } => {
    const matches = matchPerson(person.label, peopleNeedle)?.positions;
    const key = personKey(person.pubkey);
    const newSession = !!openAgentSession && sessionAgents.has(person.pubkey);
    const dm = list.channels.some(
      (channel) =>
        channel.channelType === "dm" &&
        !channel.archived &&
        channel.participants?.length === 1 &&
        channel.participants[0] === person.pubkey,
    );
    return {
      key,
      label: person.label,
      ...(matches?.length ? { matches } : {}),
      detail: [
        person.username && `@${person.username}`,
        newSession
          ? "New chat"
          : dm
            ? "Direct message"
            : "Start a direct message",
      ]
        .filter(Boolean)
        .join(" · "),
      icon: ChatCircleIcon,
      avatar: {
        src: avatarMedia(person.picture, session.media),
        shape: person.agent ? "squircle" : "circle",
      },
      order,
      run: choose(key, () =>
        newSession
          ? openAgentSession(person.pubkey)
          : void openPerson(person.pubkey, person.label, person.agent),
      ),
    };
  };
  const personResults = rankedPeople
    .filter(({ person }) => !person.agent)
    .slice(0, PERSON_ROWS)
    .map(personDestination);
  const agentResults = rankedPeople
    .filter(({ person }) => person.agent)
    .slice(0, PERSON_ROWS)
    .map(personDestination);
  const recent: SearchDestination[] = channels
    .filter((channel) => !channel.readOnly && !channel.archived)
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt ?? 0) -
        (a.lastActivityAt ?? a.updatedAt ?? 0),
    )
    .slice(0, 4)
    .map((channel) => ({
      ...conversationDestination(channel),
      ...(channel.preview ? { detail: channel.preview } : {}),
    }));
  const currentChannel = currentChannelId
    ? channels.find((channel) => channel.id === currentChannelId)
    : undefined;
  const scopeAction: SearchDestination[] =
    !scopedChannelId && currentChannel && onScopeChange
      ? [
          {
            key: `scope:${currentChannel.id}`,
            label: `Search ${currentChannel.channelType === "dm" ? "conversation with" : "in"} ${names.get(currentChannel.id) ?? currentChannel.name}`,
            detail: "Search messages in this conversation",
            icon: ChatCircleIcon,
            run: () => onScopeChange(currentChannel.id),
          },
        ]
      : [];
  const messages: SearchDestination[] = search.messages.map((message) => {
    const displayId = message.workflowOwnerId ?? message.authorId;
    const name = resolveName(
      displayId,
      profiles.get(displayId)?.name ?? displayId.slice(0, 10),
      list.channels.find((channel) => channel.id === message.channelId)
        ?.members ?? [],
    );
    return {
      key: message.id,
      label: message.preview,
      detail: `${names.get(message.channelId) ?? session.channels.get?.(message.channelId)?.name ?? "Conversation"} · ${message.workflowOwnerId ? workflowLabel(name) : name} · ${new Date(message.createdAt * 1000).toLocaleDateString()}`,
      icon: ChatCircleIcon,
      run: () => openConversation(message.channelId, message.id),
    };
  });
  const operatorLookupPending =
    needsPublicLookup &&
    (list.status !== "ready" || operatorPublicChannels.loading);
  const operatorLookupError = needsPublicLookup
    ? operatorPublicChannels.error
    : undefined;
  const messageEmpty =
    operatorLookupPending || search.loading
      ? "Searching messages…"
      : operatorLookupError || search.error
        ? "Message search is unavailable."
        : query.trim()
          ? "No matching messages in accessible conversations."
          : scopedChannelId
            ? "Type to search messages in this conversation."
            : "Type to search messages in this community.";
  // A retry removes its own focused button. Return focus to the combobox,
  // which owns keyboard navigation, before the retry starts.
  const retryFromInput = (retry: () => unknown) => () => {
    input.current?.focus();
    retry();
  };
  const groups =
    pickerPrompt || showAmbiguousPicker
      ? [
          {
            label: "People",
            destinations: authorChoices.filter((choice) => !choice.isAgent),
            empty: authorChoices.length
              ? undefined
              : authorSuggestions?.query !== query
                ? "Searching people…"
                : authorSuggestions.lookupFailed
                  ? "People search is unavailable. Try a longer name."
                  : authorNeedle
                    ? "No matching people. Try a different name."
                    : "Type a name to search people.",
          },
          {
            label: "Agents",
            destinations: authorChoices.filter((choice) => choice.isAgent),
          },
        ]
      : showDateChoices
        ? [{ label: "Dates", destinations: dateChoices }]
        : scopedChannelId
          ? [
              {
                label: "Most relevant",
                destinations: messages,
                empty: messageEmpty,
              },
            ]
          : !query.trim()
            ? [
                ...(scopeAction.length
                  ? [{ label: "This conversation", destinations: scopeAction }]
                  : []),
                {
                  label: "Recent activity",
                  destinations: recent,
                  empty:
                    list.status === "loading"
                      ? "Loading recent conversations…"
                      : "No recent activity yet.",
                },
                {
                  label: "Actions",
                  destinations: pages.map((page) => ({
                    ...page,
                    run: choose(page.key, page.run),
                  })),
                },
              ]
            : [
                // Named destinations lead, so typed text selects one first.
                // The group with the best match leads them, so Enter opens
                // the "Work" page before a channel that merely contains it.
                ...[
                  {
                    label: "Channels",
                    destinations: channelResults.map(conversationDestination),
                    best: Math.min(...channelResults.map(channelRank)),
                  },
                  {
                    label: "Direct messages",
                    destinations: directMessageResults.map(
                      conversationDestination,
                    ),
                    best: Math.min(...directMessageResults.map(channelRank)),
                  },
                  {
                    label: "People",
                    destinations: personResults,
                    best: Math.min(...personResults.map(({ order }) => order)),
                  },
                  {
                    label: "Agents",
                    destinations: agentResults,
                    best: Math.min(...agentResults.map(({ order }) => order)),
                  },
                  {
                    label: "Pages",
                    // PageSearch already ranked these by text and underlined
                    // them; here usage and earlier choices adjust the order.
                    destinations: byMatch(pages, (page) =>
                      rankOf(page.label, page.key),
                    ).map((page) => ({
                      ...page,
                      run: choose(page.key, page.run),
                    })),
                    best: Math.min(
                      ...pages.map((page) => rankOf(page.label, page.key)),
                    ),
                  },
                ]
                  .sort((a, b) => a.best - b.best)
                  .map(({ best: _, ...group }) => group),
                ...(scopeAction.length
                  ? [{ label: "This conversation", destinations: scopeAction }]
                  : []),
                {
                  label: "Most relevant",
                  destinations: messages,
                  empty:
                    matchingChannels.length ||
                    channelResults.length ||
                    rankedPeople.length ||
                    pages.length
                      ? undefined
                      : messageEmpty,
                },
              ];
  return (
    <SearchChoices
      query={query}
      onQueryChange={onQueryChange}
      authorChip={
        showAuthorChip && selectedAuthor
          ? {
              label: selectedAuthor.name,
              title: npubEncode(selectedAuthor.pubkey),
              onRemove: removeSelectedAuthor,
            }
          : undefined
      }
      displayQuery={displayQuery}
      onDisplayQueryChange={updateDisplayQuery}
      input={input}
      label={scopedChannelId ? "Search this conversation" : "Search Buzz"}
      placeholder={
        scopedChannelId
          ? "Search messages…"
          : "Search pages, people, conversations and messages…"
      }
      scope={
        scopedChannelId && onScopeChange
          ? {
              label:
                names.get(scopedChannelId) ??
                session.channels.get?.(scopedChannelId)?.name ??
                "Conversation",
              onRemove: () => onScopeChange(),
            }
          : undefined
      }
      groups={groups}
    >
      <div
        className="space-y-2 px-3 text-body-sm text-subtle"
        aria-live="polite"
      >
        {list.status === "loading" && query.trim() && !list.channels.length && (
          <p>Loading joined conversations…</p>
        )}
        {list.status === "error" && (
          <div>
            <p>Couldn’t load all joined conversations.</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(() =>
                session.channels.refreshList
                  ? session.channels.refreshList()
                  : session.channels.ensureList(),
              )}
            >
              Retry conversations
            </Button>
          </div>
        )}
        {list.coverage === "partial" && (
          <p>Conversation names include only loaded joined conversations.</p>
        )}
        {query.trim() &&
          !scopedChannelId &&
          (publicChannels.partial || operatorPublicChannels.partial) && (
            <p>Only the newest open channels were searched.</p>
          )}
        {!scopedChannelId && publicChannels.error && (
          <div>
            <p>{publicChannels.error}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(publicChannels.retry)}
            >
              Retry channels
            </Button>
          </div>
        )}
        {operatorLookupError && (
          <div>
            <p>{operatorLookupError}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(operatorPublicChannels.retry)}
            >
              Retry channels
            </Button>
          </div>
        )}
        {personOpen && (
          <p role={personOpen.error ? "alert" : undefined}>
            {personOpen.error ??
              `Opening your conversation with ${personOpen.name}…`}
          </p>
        )}
        {peopleActive && personDirectory.error && (
          <div>
            <p>Couldn’t search community people.</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(personDirectory.retry)}
            >
              Retry people
            </Button>
          </div>
        )}
        {search.error && (
          <div>
            <p>{search.error}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(search.retry)}
            >
              Retry messages
            </Button>
          </div>
        )}
      </div>
    </SearchChoices>
  );
}
