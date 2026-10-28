import { useChannelIdentityNames } from "../identity-names/react";
import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import type { ComposerSession } from "./composer-session";
import { MessageLink } from "../conversation/MessageLink";
import { messageLinkParts } from "./message-link-parts";
import {
  ReferenceText,
  channelForLink,
  channelLinkLabel,
  emptyReferenceDirectory,
} from "./ReferenceText";
import {
  AtIcon,
  CopyIcon,
  RobotIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { profileKey } from "../profiles/target";
import referenceStyles from "../../shared/InlineReference.module.css";
import type { Root } from "hast";
import { type Components, toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ExtraProps } from "react-markdown";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type {
  CodeBlockRenderer,
  ContributionReader,
  ConversationExtensions,
} from "../conversation/contracts";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import { resolveMatch } from "../../plugins/contributions";
import { InlineText } from "../conversation/InlineText";
import type { ChannelMessage, Profile } from "../relay/contracts";
import styles from "./Messages.module.css";
import { prepareMarkdown } from "./markdown-preparation";
import {
  inlineProtectionKey,
  messageMarkdownTree,
  preparedMarkdown,
} from "./message-markdown-compile";

const labelText = (children: ReactNode): string =>
  Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? labelText(child.props.children)
        : String(child),
    )
    .join("");

type MessageComponents = {
  [Tag in "p" | "a" | "img" | "span" | "pre"]: (
    props: ComponentPropsWithoutRef<Tag> & ExtraProps,
  ) => ReactNode;
};
const MessageComponentsContext = createContext<MessageComponents | null>(null);
function useMessageComponents() {
  const components = useContext(MessageComponentsContext);
  if (!components) throw new Error("Missing message rendering context");
  return components;
}
// Keep component types stable: profile/directory updates must not remount a
// focused link or discard its pending preview timer.
const markdownComponents: Components = {
  p: (props) => useMessageComponents().p(props),
  a: (props) => useMessageComponents().a(props),
  img: (props) => useMessageComponents().img(props),
  span: (props) => useMessageComponents().span(props),
  pre: (props) => useMessageComponents().pre(props),
  table: ({ node: _node, ...props }) => (
    <table ref={observeTableOverflow} {...props} />
  ),
};

/** WebKit adds an `overflow-x: auto` scrollbar after flex and grid ancestors
 * have taken their heights, then lays out only the table again. A scrollbar
 * that takes space then overlaps the next row, or leaves a gap when removed.
 * CSS chooses the scrollbar from measured overflow so it is laid out with
 * the ancestors. Observe content too: edits can change scrollWidth without
 * resizing a table at its width cap. Measure on mount because the resize
 * observer's first report arrives after the row's. */
function observeTableOverflow(table: HTMLTableElement | null) {
  if (!table || typeof ResizeObserver === "undefined") return;
  const update = () => {
    const overflow = String(table.scrollWidth > table.clientWidth);
    if (table.dataset.overflow !== overflow) table.dataset.overflow = overflow;
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(table);
  const contentObserver = new MutationObserver(update);
  contentObserver.observe(table, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  return () => {
    observer.disconnect();
    contentObserver.disconnect();
  };
}

export function MessageMarkdown({
  row,
  directory = emptyReferenceDirectory,
  session,
  scope,
  extensions,
  media,
  onOpenLink,
  canOpenLink,
  participantProfiles,
  largeEmoji = false,
  interactive = true,
  staticMentions = false,
}: {
  row: ChannelMessage;
  directory?: typeof emptyReferenceDirectory;
  session?: RelaySession | ComposerSession | undefined;
  scope?: string | undefined;
  extensions?: ConversationExtensions | undefined;
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
  largeEmoji?: boolean | undefined;
  interactive?: boolean;
  /** Preserve signed mention presentation when this surface cannot open profiles. */
  staticMentions?: boolean | undefined;
}) {
  const resolveName = useChannelIdentityNames(session, row.channelId);
  const prepared = useMemo(
    () => preparedMarkdown(row.content, () => prepareMarkdown(row.content)),
    [row.content],
  );
  if (prepared.kind === "plain")
    return <div className={styles.plainText}>{prepared.content}</div>;
  return (
    <PreparedMessageMarkdown
      row={row}
      prepared={prepared}
      directory={directory}
      session={session}
      scope={scope}
      extensions={extensions}
      media={media}
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
      participantProfiles={participantProfiles}
      resolveName={resolveName}
      largeEmoji={largeEmoji}
      interactive={interactive}
      staticMentions={staticMentions}
    />
  );
}

function PreparedMessageMarkdown({
  row: sourceRow,
  prepared,
  directory = emptyReferenceDirectory,
  session,
  scope,
  extensions,
  media,
  onOpenLink,
  canOpenLink,
  participantProfiles,
  resolveName,
  largeEmoji = false,
  interactive = true,
  staticMentions = false,
}: Parameters<typeof MessageMarkdown>[0] & {
  prepared: Extract<ReturnType<typeof prepareMarkdown>, { kind: "markdown" }>;
  resolveName: (pubkey: string, fallback: string) => string;
}) {
  const row =
    prepared.content === sourceRow.content
      ? sourceRow
      : { ...sourceRow, content: prepared.content };
  const renderLink = (url: string, label?: string, children?: ReactNode) => {
    const channel = channelForLink(url, directory.channels);
    return (
      <MessageLink
        url={url}
        label={label}
        directoryLabel={channelLinkLabel(url, directory.channels)}
        registry={extensions?.links}
        onOpenLink={onOpenLink}
        session={session}
        scope={scope}
        interactive={interactive}
        channelPrivate={!!channel?.private}
      >
        {children}
      </MessageLink>
    );
  };
  const renderInline = (text: string) =>
    extensions ? (
      <InlineText
        registry={extensions.inline}
        content={{ text, message: row }}
        media={media}
      />
    ) : (
      text
    );
  const renderText = (text: string) => {
    let offset = 0;
    return messageLinkParts(text).map((part) => {
      const key = `${offset}:${part.text}`;
      offset += part.text.length;
      return part.url ? (
        <span key={key}>{renderLink(part.url, part.label)}</span>
      ) : (
        <ReferenceText
          channelId={row.channelId}
          key={key}
          text={part.text}
          mentions={[]}
          directory={directory}
          renderText={renderInline}
          onOpenLink={onOpenLink}
          extensions={extensions}
          session={session}
          scope={scope}
          interactive={interactive}
        />
      );
    });
  };

  const profiles = participantProfiles ?? directory.profiles;
  const protectionKey = inlineProtectionKey(
    sourceRow,
    profiles,
    directory.agents,
  );
  // The key contains every row/profile/agent/emoji value consumed below. It
  // avoids reparsing for equivalent folded rows without hiding live inputs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: semantic key
  const tree = useMemo(
    () =>
      messageMarkdownTree(
        sourceRow,
        prepared,
        profiles,
        directory.agents,
        protectionKey,
      ),
    [sourceRow.content, protectionKey],
  );
  // Explicit profile links are identity locators, not signed notification intent.
  // Reuse the same control and availability gate as bound prose mentions.
  const renderProfile = (text: unknown, target: unknown) => {
    const key = typeof target === "string" ? profileKey(target) : undefined;
    const agent =
      !!key &&
      (directory.agents.some((agent) => agent.pubkey === key) ||
        (participantProfiles ?? directory.profiles).get(key)?.isAgent);
    const clickable =
      interactive && typeof target === "string" && !!canOpenLink?.(target);
    if (
      typeof text === "string" &&
      typeof target === "string" &&
      (!interactive || clickable || agent || staticMentions)
    ) {
      const label = key ? resolveName(key, text.slice(1)) : text.slice(1);
      const Icon = agent ? RobotIcon : AtIcon;
      const Mention = clickable ? "button" : "span";
      // Selection copy reads the identity and the whole label (selection-copy.ts).
      return (
        <Mention
          type={clickable ? "button" : undefined}
          className={referenceStyles.link}
          data-mention-kind={agent ? "agent" : "person"}
          data-mention-self={key && key === session?.viewer ? "" : undefined}
          data-profile-target={target}
          data-mention-name={label}
          aria-label={clickable ? `View ${label} profile` : undefined}
          onClick={
            clickable
              ? (event) => {
                  event.currentTarget.focus();
                  onOpenLink(target);
                }
              : undefined
          }
        >
          <Icon aria-hidden="true" className={referenceStyles.icon} />
          {label}
        </Mention>
      );
    }
    return undefined;
  };
  const components: MessageComponents = {
    p: ({ node: _node, ...props }) => (
      <p
        {...props}
        className={largeEmoji ? styles.text : undefined}
        data-single-emoji={largeEmoji || undefined}
      />
    ),
    a: ({ href, children }) => {
      if (href && profileKey(href)) {
        const label = labelText(children);
        if (!interactive || !canOpenLink?.(href))
          return (
            <span>
              {children} ({href})
            </span>
          );
        return renderProfile(label.startsWith("@") ? label : `@${label}`, href);
      }
      return href ? (
        renderLink(
          href,
          labelText(children) === href ? undefined : labelText(children),
          labelText(children) === href ? undefined : children,
        )
      ) : (
        <span>{children}</span>
      );
    },
    img: ({ node: _node, alt }) =>
      alt ? <span className={styles.imageAlt}>{alt}</span> : null,
    span: ({ node: _node, children, ...props }) => {
      if ((props as Record<string, unknown>)["data-spoiler"] === "true")
        return (
          <MessageSpoiler key={row.content} interactive={interactive}>
            {children}
          </MessageSpoiler>
        );
      const {
        "data-inline-text": text,
        "data-profile-target": target,
        "data-literal-text": literalText,
      } = props as typeof props & {
        "data-inline-text"?: unknown;
        "data-profile-target"?: unknown;
        "data-literal-text"?: unknown;
      };
      const profile = renderProfile(text, target);
      if (profile) return profile;
      return typeof text === "string" ? (
        literalText === "true" ? (
          text
        ) : (
          renderText(text)
        )
      ) : (
        <span {...props}>{children}</span>
      );
    },
    pre: ({ node, children, ...props }) => {
      const code = labelText(children).replace(/\n$/, "");
      const plain = (
        <pre {...props}>
          {children}
          {interactive && <CodeActions code={code} />}
        </pre>
      );
      const language = codeLanguage(node);
      // Previews are not interactive, so they keep the plain code.
      return interactive && language && extensions?.codeBlocks ? (
        <CodeBlock
          registry={extensions.codeBlocks}
          language={language}
          code={code}
          fallback={plain}
        />
      ) : (
        plain
      );
    },
  };

  const markdown = (
    <MessageComponentsContext value={components}>
      <MarkdownBody tree={tree} />
    </MessageComponentsContext>
  );
  return largeEmoji ? markdown : <div className={styles.text}>{markdown}</div>;
}

export function renderMessageMarkdown(tree: Root, components: Components) {
  return toJsxRuntime(tree, {
    Fragment,
    components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  });
}

const MarkdownBody = memo(function MarkdownBody({ tree }: { tree: Root }) {
  return renderMessageMarkdown(tree, markdownComponents);
});

function MessageSpoiler({
  children,
  interactive,
}: {
  children: ReactNode;
  interactive: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className={styles.spoiler} data-revealed={revealed}>
      {interactive ? (
        <button
          type="button"
          className={styles.spoilerMask}
          aria-label={revealed ? "Hide spoiler" : "Reveal spoiler"}
          aria-expanded={revealed}
          onClick={(event) => {
            event.stopPropagation();
            setRevealed(!revealed);
          }}
        />
      ) : (
        <span className={styles.spoilerMask} aria-hidden="true" />
      )}
      <span
        className={styles.spoilerContent}
        aria-hidden={!revealed}
        inert={!revealed}
      >
        {children}
      </span>
    </span>
  );
}

/** The fence's info-string language, as remark records it on the inner `code`. */
function codeLanguage(pre: ExtraProps["node"]) {
  const code = pre?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return undefined;
  const classes = code.properties.className;
  return Array.isArray(classes)
    ? classes
        .map(String)
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length)
    : undefined;
}

/** A plugin presents the block and may add an action; the host keeps the frame,
 * action placement and copy, and restores the plain code when the plugin fails
 * or is removed. */
function CodeBlock({
  registry,
  language,
  code,
  fallback,
}: {
  registry: ContributionReader<CodeBlockRenderer>;
  language: string;
  code: string;
  fallback: ReactNode;
}) {
  const renderers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const renderer = resolveMatch(renderers, language);
  if (!renderer) return fallback;
  const { component: Renderer, action: Action } = renderer;
  return (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${language}:${code}`}
      fallback={fallback}
    >
      {/* Selection copy reads the source here (selection-copy.ts). */}
      <div
        className={styles.codeBlock}
        data-copy-code={code}
        data-copy-language={language}
      >
        <Renderer code={code} language={language} />
        <CodeActions code={code}>
          {Action && <Action code={code} language={language} />}
        </CodeActions>
      </div>
    </ContributionBoundary>
  );
}

function CodeActions({
  code,
  children,
}: {
  code: string;
  children?: ReactNode;
}) {
  const notify = useToastNotification();
  const [copying, setCopying] = useState(false);
  return (
    <span className={styles.codeActions}>
      {children}
      <IconButton
        hint="familiar"
        aria-label="Copy code block"
        title="Copy code block"
        disabled={copying}
        focusableWhenDisabled
        icon={<CopyIcon />}
        onClick={() => {
          setCopying(true);
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(code))
            .then(
              () => notify("Copied code to clipboard", "success"),
              () => notify("Failed to copy code", "error"),
            )
            .finally(() => setCopying(false));
        }}
      />
    </span>
  );
}
