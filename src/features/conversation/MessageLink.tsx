import {
  canPreviewSnapshotLink,
  requestSnapshotLinkPreview,
} from "../agents/snapshot-preview";
import { useConversationPresentation } from "./ConversationPresentation";
import {
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type MouseEvent,
} from "react";
import { resolveMatch, type Contribution } from "../../plugins/contributions";
import type { ContributionReader, LinkRenderer } from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuPopup,
  MenuLinkItem,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import {
  BrowserIcon,
  CopyIcon,
  FileTextIcon,
} from "../../shared/design-system/icons";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import type { RelaySession } from "../relay/session";
import { parseBuzzLink, isBuzzLink } from "../navigation/buzz-links";
import {
  LinkChannelPrivateContext,
  LinkLabelContext,
  LinkContentContext,
} from "./LinkLabelContext";
import { BuzzLinkPreview } from "./BuzzLinkPreview";
import { messageViewKey } from "../messages/view-key";
import styles from "./LinkPreview.module.css";

const empty: readonly Contribution<LinkRenderer>[] = [];
const snapshot = () => empty;
const subscribe = () => () => {};

/** Lowest `order` among active matches wins, like panels; a broken matcher
 * leaves other candidates eligible and never prevents opening a link. */
export const resolveLink = (
  url: string,
  renderers: readonly Contribution<LinkRenderer>[],
) => resolveMatch(renderers, url);

export function MessageLink({
  url,
  children,
  registry,
  onOpenLink,
  label,
  directoryLabel,
  session,
  scope,
  interactive = true,
  channelPrivate = false,
}: {
  url: string;
  children?: ReactNode;
  registry: ContributionReader<LinkRenderer> | undefined;
  onOpenLink(url: string): boolean;
  label?: string | undefined;
  /** The receiving community's name for a raw destination. Display only: a raw
   * link copies as its URL. */
  directoryLabel?: string | undefined;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  interactive?: boolean;
  channelPrivate?: boolean;
}) {
  const active = useConversationPresentation();
  const renderers = useSyncExternalStore(
    registry?.subscribe ?? subscribe,
    registry?.snapshot ?? snapshot,
    registry?.snapshot ?? snapshot,
  );
  const renderer = resolveLink(url, renderers);
  const [unavailable, setUnavailable] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  if (!active && previewOpen) setPreviewOpen(false);
  const trigger = useRef<HTMLAnchorElement>(null);
  const display = label ?? directoryLabel;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLAnchorElement>();
  const [copying, setCopying] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  if (!active && menuOpen) setMenuOpen(false);
  if (!active && notice) setNotice(undefined);
  const external = /^https?:\/\//i.test(url);
  async function copy() {
    if (!active || busy.current) return;
    busy.current = true;
    setCopying(true);
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(url);
      setNotice({ text: "Link copied", error: false });
    } catch {
      setNotice({
        text: "Couldn’t copy the link. Try again from the link menu.",
        error: true,
      });
    } finally {
      busy.current = false;
      setCopying(false);
    }
  }
  const internal = isBuzzLink(url);
  const parsed = internal ? parseBuzzLink(url) : null;
  const destination = parsed?.format === "legacy" ? parsed : undefined;
  const sessionChip =
    !!session &&
    !!destination &&
    !destination.messageId &&
    !!session.channels
      .list()
      .channels.find(
        (item) =>
          item.id === destination.channelId &&
          item.channelType === "session" &&
          !item.cached &&
          !item.readOnly &&
          item.members?.includes(session.viewer ?? ""),
      ) &&
    label === `Session · ${destination.channelId.slice(0, 8)}`;
  const preview =
    session && destination?.messageId
      ? { channelId: destination.channelId, messageId: destination.messageId }
      : undefined;
  const navigation = {
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (!active) {
        event.preventDefault();
        return;
      }
      if (internal) {
        event.preventDefault();
        if (trigger.current?.isConnected)
          trigger.current.focus({ preventScroll: true });
        const opened = onOpenLink(url);
        setUnavailable(!opened);
        if (opened) setPreviewOpen(false);
        return;
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        onOpenLink(url)
      )
        event.preventDefault();
    },
    onAuxClick: internal
      ? (event: MouseEvent<HTMLAnchorElement>) => {
          if (!active) {
            event.preventDefault();
            return;
          }
          if (event.button === 1) {
            event.preventDefault();
            if (trigger.current?.isConnected)
              trigger.current.focus({ preventScroll: true });
            const opened = onOpenLink(url);
            setUnavailable(!opened);
            if (opened) setPreviewOpen(false);
          }
        }
      : undefined,
  };
  const anchor = (entry?: Contribution<LinkRenderer>) => {
    const Content = entry?.component;
    const content =
      sessionChip && destination ? (
        <span className={styles.sessionChip}>
          <FileTextIcon size="1em" aria-hidden="true" />
          <span className="text-subtle">Session</span>
          <span>· {destination.channelId.slice(0, 8)}</span>
        </span>
      ) : Content ? (
        <Content url={url} />
      ) : (
        (children ?? display ?? url)
      );
    // Selection copy reads the authored label; empty marks a raw destination.
    const element = interactive ? (
      <a
        ref={trigger}
        href={url}
        aria-label={display}
        data-link-label={label ?? ""}
        title={!preview ? url : undefined}
        className={sessionChip ? styles.sessionLink : entry?.className}
        data-link-renderer={entry?.key}
        {...navigation}
      >
        {content}
      </a>
    ) : (
      <span className={entry?.className} data-link-renderer={entry?.key}>
        {content}
      </span>
    );
    if (active && interactive && external) {
      return (
        <ContextMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
          <ContextMenuTrigger
            render={element}
            onContextMenu={() => setMenuAnchor(undefined)}
            onTouchStart={() => setMenuAnchor(undefined)}
            onKeyDown={(event) => {
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                setMenuAnchor(trigger.current ?? undefined);
                setMenuOpen(true);
              }
            }}
          />
          <MenuPopup size="compact" anchor={menuAnchor} finalFocus={trigger}>
            <MenuLinkItem
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              closeOnClick
            >
              <MenuIcon>
                <BrowserIcon size={16} />
              </MenuIcon>
              Open in browser
            </MenuLinkItem>
            {session && canPreviewSnapshotLink(session, url) && (
              <MenuItem
                onClick={() => {
                  try {
                    requestSnapshotLinkPreview(session, url);
                  } catch {
                    setNotice({
                      text: "Snapshot preview is unavailable.",
                      error: true,
                    });
                  }
                }}
              >
                Preview snapshot
              </MenuItem>
            )}
            <MenuItem disabled={copying} onClick={() => void copy()}>
              <MenuIcon>
                <CopyIcon size={16} />
              </MenuIcon>
              Copy link
            </MenuItem>
          </MenuPopup>
        </ContextMenuRoot>
      );
    }
    return active && interactive && preview && session ? (
      <PreviewCard
        trigger={element}
        link={<a href={url} {...navigation} />}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        side="top"
        className={styles.popup ?? ""}
        aria-label="Message preview"
      >
        {previewOpen && (
          <BuzzLinkPreview
            key={messageViewKey(session, scope, url)}
            session={session}
            channelId={preview.channelId}
            messageId={preview.messageId}
          />
        )}
      </PreviewCard>
    ) : (
      element
    );
  };
  const link = renderer ? (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${url}`}
      fallback={anchor()}
    >
      {anchor(renderer)}
    </ContributionBoundary>
  ) : (
    anchor()
  );
  const result = (
    <>
      {link}
      {active && notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => setNotice(undefined)}
        />
      )}
      {unavailable && (
        <span role="status"> This Buzz link couldn’t be opened here.</span>
      )}
    </>
  );
  return (
    <LinkChannelPrivateContext value={channelPrivate}>
      <LinkLabelContext value={display}>
        <LinkContentContext value={children}>{result}</LinkContentContext>
      </LinkLabelContext>
    </LinkChannelPrivateContext>
  );
}
