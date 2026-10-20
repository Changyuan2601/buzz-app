import type {
  AdminAccessReader,
  AdminAccessState,
} from "../bundled/admin-access";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
  type HTMLMotionProps,
} from "motion/react";
import type { Agents } from "../features/agents/service";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Panel } from "../shared/design-system/ui/Panel";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../shared/design-system/ui/NavigationSection";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { SurfaceButton } from "../shared/design-system/ui/SurfaceButton";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { ChoiceRow } from "../shared/design-system/ui/ChoiceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Tabs } from "../shared/design-system/ui/Tabs";
import { SearchField } from "../shared/design-system/ui/SearchField";
import { EmptyState } from "../shared/design-system/ui/EmptyState";
import {
  type ReactNode,
  forwardRef,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { RecoveryScreen } from "./RecoveryScreen";
import styles from "./Settings.module.css";
import {
  CheckCircleIcon,
  SparklesIcon,
  SquaresFourIcon,
  XIcon,
} from "../shared/design-system/icons/index";
import type { PluginManager } from "../plugins/manager";
import type { PluginInfo } from "../plugins/types";
import type { Communities, Membership } from "../features/communities/service";
import { PluginImport } from "./PluginImport";
import { PluginReadme } from "./PluginReadme";
import { bundledReadmes } from "../bundled/readmes";
import { bundledIcons } from "../bundled/icons";
import type { Identity } from "../features/identity/service";
import { ProfileSettings } from "./ProfileSettings";
import { IdentitySettings } from "./IdentitySettings";

import type { Appearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { NotificationsService } from "../features/notifications/service";
import type { ShortcutsService } from "../features/shortcuts/service";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import { ShortcutSettings } from "./ShortcutSettings";
import { DeveloperSettings } from "./DeveloperSettings";
import { AgentSettings } from "./AgentSettings";
import type { SettingsCards } from "../features/settings/service";
import { OwnedContribution } from "../plugins/OwnedContribution";
import type { Updates } from "../features/updates/updates";
import { UpdateSettings } from "../features/updates/UpdateSettings";
import { CommunityDepartureSettings } from "./CommunityDepartureSettings";
import { developerMode, settingsSections } from "./settings-sections";

import { pluginCategoryDefinitions } from "./plugin-categories";

// Exit animations retain DOM briefly; retired results must stop accepting focus.
const PluginListEntry = forwardRef<HTMLDivElement, HTMLMotionProps<"div">>(
  function PluginListEntry(props, ref) {
    const present = useIsPresent();
    return (
      <motion.div
        {...props}
        ref={ref}
        inert={!present}
        aria-hidden={!present || undefined}
      />
    );
  },
);

function CorePluginGroup({ children }: { children: ReactNode }) {
  return (
    <div className={styles.pluginCoreGrid}>
      <SettingsGroup layout="cards">{children}</SettingsGroup>
    </div>
  );
}

function isCorePlugin(plugin: PluginInfo) {
  return (
    plugin.source === "bundled" &&
    (plugin.manifest.discovery?.tags?.some(
      (tag) => tag.trim().toLowerCase() === "core",
    ) ??
      false)
  );
}

function isRequiredPlugin(plugin: PluginInfo) {
  return plugin.manifest.id === "buzz.channels";
}

function isEssentialPlugin(plugin: PluginInfo) {
  return (
    plugin.source === "bundled" &&
    (plugin.manifest.discovery?.tags?.some(
      (tag) => tag.trim().toLowerCase() === "essentials",
    ) ??
      false)
  );
}

function comparePlugins(a: PluginInfo, b: PluginInfo) {
  return (
    Number(isRequiredPlugin(b)) - Number(isRequiredPlugin(a)) ||
    Number(isEssentialPlugin(b)) - Number(isEssentialPlugin(a)) ||
    a.manifest.name.localeCompare(b.manifest.name)
  );
}

function groupPlugins(plugins: readonly PluginInfo[]) {
  const known = new Map<string, PluginInfo[]>(
    pluginCategoryDefinitions.map(({ id }) => [id, []]),
  );
  const other: PluginInfo[] = [];
  const core: PluginInfo[] = [];
  for (const plugin of plugins) {
    if (isCorePlugin(plugin)) {
      core.push(plugin);
      continue;
    }
    const group = known.get(plugin.manifest.discovery?.category ?? "");
    (group ?? other).push(plugin);
  }
  for (const entries of known.values()) entries.sort(comparePlugins);
  other.sort(comparePlugins);
  return [
    ...(core.length
      ? [
          {
            id: "core",
            plugins: core.sort(comparePlugins),
          },
        ]
      : []),
    ...pluginCategoryDefinitions.flatMap(({ id, label }) => {
      const entries = known.get(id) ?? [];
      return entries.length ? [{ id, label, plugins: entries }] : [];
    }),
    ...(other.length ? [{ id: "other", label: "Other", plugins: other }] : []),
  ];
}

function PluginIcon({
  plugin,
  size = 24,
}: {
  plugin: PluginInfo;
  size?: number;
}) {
  const url =
    plugin.source === "bundled"
      ? bundledIcons.get(plugin.manifest.id)
      : undefined;
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <span
      className={styles.pluginIcon}
      data-branded={Boolean(url && url !== failedUrl) || undefined}
      data-category={plugin.manifest.discovery?.category}
      aria-hidden="true"
    >
      {url && url !== failedUrl ? (
        <img src={url} alt="" onError={() => setFailedUrl(url)} />
      ) : (
        <SquaresFourIcon size={size} />
      )}
    </span>
  );
}

function PluginProvenance({
  source,
  publisher,
  className,
}: {
  source: "bundled" | "external";
  publisher?: string | null | undefined;
  className?: string | undefined;
}) {
  if (source !== "bundled" && !publisher) return null;
  return (
    <span className={`${styles.pluginProvenance} ${className ?? ""}`}>
      <span>{source === "bundled" ? "Buzz" : publisher}</span>
    </span>
  );
}

const noAccessSubscription = () => () => {};

function restrictedPlugin(plugin: PluginInfo) {
  return (
    plugin.source === "bundled" &&
    (plugin.manifest.id === "buzz.moderation" ||
      plugin.manifest.id === "buzz.relay-staff")
  );
}

function pluginActionLabel(plugin: PluginInfo, access: AdminAccessState) {
  if (plugin.enabled) return "Disable";
  if (restrictedPlugin(plugin) && access !== "allowed")
    return access === "checking" ? "Enable" : "Unavailable";
  return "Enable";
}

function accessMessage(plugin: PluginInfo, state: AdminAccessState) {
  switch (state) {
    case "allowed":
      return null;
    case "checking":
      return "Checking access…";
    case "no-community":
      return "Select a community to check access.";
    case "error":
      return "Could not check access. Open details to try again.";
    case "unavailable":
      return "Access is unavailable in this build or on this relay.";
    case "denied":
      return plugin.manifest.id === "buzz.moderation"
        ? "Select a community where you’re an owner or admin."
        : "Select a community on a relay where you have staff access.";
  }
}

/** Narrow containers cover the catalog with details (Settings.module.css). */
function covered(element: Element | null) {
  return !!element && getComputedStyle(element).visibility === "hidden";
}

function PluginDetails({
  plugin,
  failure,
  busy,
  plugins,
  onToggle,
  close,
  onClose,
  access,
  onCheckAccess,
}: {
  plugin: PluginInfo;
  failure: string | null;
  busy: boolean;
  plugins: PluginManager;
  onToggle(): void;
  close: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  access: AdminAccessState;
  onCheckAccess(): void;
}) {
  const accessReason = restrictedPlugin(plugin)
    ? accessMessage(plugin, access)
    : null;
  const toggle = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  useLayoutEffect(() => {
    close.current?.focus();
  }, [close]);
  // READMEs ship with Buzz; never attach one to an external plugin.
  const readme =
    plugin.source === "bundled" && bundledReadmes.get(plugin.manifest.id);
  const otherTags = (plugin.manifest.discovery?.tags ?? []).filter(
    (tag) =>
      !isEssentialPlugin(plugin) || tag.trim().toLowerCase() !== "essentials",
  );
  return (
    <aside
      id="plugin-details"
      className={styles.pluginAside}
      aria-label={`${plugin.manifest.name} details`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className={styles.pluginAsideHeader}>
        <div className={styles.pluginAsideIdentity}>
          <PluginIcon key={plugin.manifest.id} plugin={plugin} size={48} />
          <h2>{plugin.manifest.name}</h2>
          <div className={styles.pluginBadges}>
            {plugin.source === "bundled" ? (
              <span className={styles.pluginInstallBadge}>
                <CheckCircleIcon size={14} aria-hidden="true" />
                Made by Buzz
              </span>
            ) : (
              <PluginProvenance
                source={plugin.source}
                publisher={plugin.publisher}
              />
            )}
            {isEssentialPlugin(plugin) && (
              <span className={styles.pluginInstallBadge}>
                <SparklesIcon size={14} aria-hidden="true" />
                Essentials
              </span>
            )}
          </div>
          {plugin.manifest.description && (
            <p className={styles.pluginAsideDescription}>
              {plugin.manifest.description}
            </p>
          )}
        </div>
        <IconButton
          ref={close}
          aria-label="Close plugin details"
          size="sm"
          icon={<XIcon size={16} aria-hidden="true" />}
          onClick={onClose}
        />
      </div>
      {plugin.source === "external" && (
        <span className={styles.pluginInstallBadge}>
          <CheckCircleIcon size={14} aria-hidden="true" />
          Installed
        </span>
      )}
      <div className={styles.pluginStatus}>
        {plugin.enabled && accessReason && (
          <span className="text-caption text-muted">
            {access === "checking" ? "Checking…" : "Unavailable"}
          </span>
        )}
        {/* Channels is required and has no enable/disable control. */}
        {plugin.manifest.id === "buzz.channels" ? (
          <Button variant="outline" size="sm" disabled>
            Required
          </Button>
        ) : (
          <Tooltip
            content={
              access === "error"
                ? "Could not check access. Try again."
                : accessReason
            }
            {...(accessReason ? {} : { open: false })}
            disableHoverablePopup
          >
            <Button
              variant={
                plugin.enabled
                  ? "subtle"
                  : accessReason
                    ? "outline"
                    : "prominent"
              }
              size="sm"
              disabled={
                busy ||
                (!plugin.enabled &&
                  restrictedPlugin(plugin) &&
                  access !== "allowed")
              }
              loading={
                !plugin.enabled &&
                restrictedPlugin(plugin) &&
                access === "checking"
              }
              aria-describedby={
                accessReason ? "plugin-detail-access" : undefined
              }
              focusableWhenDisabled
              ref={toggle}
              onClick={onToggle}
            >
              {pluginActionLabel(plugin, access)}
            </Button>
          </Tooltip>
        )}
      </div>
      {accessReason && (
        <p id="plugin-detail-access" className="sr-only">
          {access === "error"
            ? "Could not check access. Try again."
            : accessReason}
        </p>
      )}
      {accessReason && access === "error" && (
        <div className={styles.pluginAccess}>
          <Button
            size="sm"
            onClick={() => {
              onCheckAccess();
              toggle.current?.focus();
            }}
          >
            Check access again
          </Button>
        </div>
      )}
      {readme && (
        <section
          className={styles.pluginAsideSection}
          aria-label={`${plugin.manifest.name} README`}
        >
          <PluginReadme key={plugin.manifest.id} text={readme} />
        </section>
      )}
      <section
        className={styles.pluginAsideSection}
        aria-labelledby="plugin-metadata-title"
      >
        <h3 id="plugin-metadata-title">Details</h3>
        <table
          className={styles.pluginMetadata}
          aria-labelledby="plugin-metadata-title"
        >
          <tbody>
            <tr>
              <th scope="row">Identifier</th>
              <td>
                <code>{plugin.manifest.id}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">Plugin API</th>
              <td>{plugin.manifest.apiVersion}</td>
            </tr>
            {otherTags.length > 0 && (
              <tr>
                <th scope="row">Tags</th>
                <td>{otherTags.join(", ")}</td>
              </tr>
            )}
            {plugin.source === "external" && (
              <>
                <tr>
                  <th scope="row">Revision</th>
                  <td>
                    <code>{plugin.revision}</code>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Signature</th>
                  <td>{plugin.hasSignature ? "Signed" : "Unsigned"}</td>
                </tr>
                {plugin.publisher && (
                  <tr>
                    <th scope="row">Publisher</th>
                    <td>
                      <code title={plugin.publisher}>{plugin.publisher}</code>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </section>
      {failure && <p className="error text-body-sm">{failure}</p>}
      <div className="actions items-center">
        {plugin.previous && (
          <Button
            type="button"
            disabled={busy || !!plugin.rollbackBlockedReason}
            onClick={() => plugins.change("rollback", plugin.manifest.id)}
          >
            Roll back
          </Button>
        )}
        {plugin.rollbackBlockedReason && (
          <span className="text-body-sm text-muted">
            {plugin.rollbackBlockedReason}
          </span>
        )}
        {plugin.reloadable && !plugin.enabled && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => plugins.reload(plugin.manifest.id)}
          >
            Reload
          </Button>
        )}
        {plugin.source === "external" && (
          <Button
            type="button"
            ref={deleteTrigger}
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
          >
            Delete
          </Button>
        )}
      </div>
      {confirmDelete && (
        <AlertDialog
          title={`Delete ${plugin.manifest.name}?`}
          description="Removes this plugin and its rollback history from Buzz. You can install it again later."
          pending={busy || deleting}
          finalFocus={deleteTrigger}
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <Button
                disabled={busy || deleting}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy || deleting}
                onClick={async () => {
                  if (busy || deleting) return;
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    if (await plugins.change("remove", plugin.manifest.id))
                      setConfirmDelete(false);
                    else
                      setDeleteError(
                        plugins.snapshot().error ??
                          "Plugin deletion wasn’t confirmed. Try again.",
                      );
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                Delete plugin
              </Button>
            </>
          }
        >
          {deleteError && (
            <p role="alert" className="error text-body-sm">
              {deleteError}
            </p>
          )}
        </AlertDialog>
      )}
    </aside>
  );
}

export function Settings({
  agents,
  cards,
  plugins,
  adminAccess,
  communities,
  identity,
  appearance,
  shortcuts,
  shortcutBindings,
  notifications,
  updates,
  navigation,
  onSection,
  navigationPane = false,
  onDeparturePending,
}: {
  agents?: Agents | undefined;
  cards: SettingsCards;
  plugins: PluginManager;
  adminAccess?: AdminAccessReader;
  communities: Communities;
  identity?: Identity | undefined;
  appearance: Appearance;
  shortcuts: ShortcutsService;
  shortcutBindings: ShortcutBindings;
  notifications: NotificationsService;
  updates: Updates;
  navigation?:
    | import("../features/navigation/service").PageNavigation
    | undefined;
  onSection?: (section: string) => void;
  navigationPane?: boolean;
  onDeparturePending?: (pending: boolean) => void;
}) {
  useEffect(() => cards.retainVisibility(), [cards]);
  useEffect(() => adminAccess?.ensure(), [adminAccess]);
  const membershipAccess = useSyncExternalStore(
    adminAccess?.subscribe ?? noAccessSubscription,
    () => adminAccess?.status("buzz.moderation") ?? "unavailable",
  );
  const moderationAccess = useSyncExternalStore(
    adminAccess?.subscribe ?? noAccessSubscription,
    () => adminAccess?.status("buzz.relay-staff") ?? "unavailable",
  );
  const pluginAccess = (plugin: PluginInfo) =>
    plugin.manifest.id === "buzz.moderation"
      ? membershipAccess
      : moderationAccess;
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const selectedCommunity = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  // Local removal drops the saved membership before session disposal/purge
  // settles. Retain only this action's context so its modal can finish.
  const [departure, setDeparture] = useState<{
    community: Membership;
    viewer: string | undefined;
  } | null>(null);
  const departureCommunity =
    departure?.viewer === client.viewer
      ? (departure?.community ?? selectedCommunity)
      : selectedCommunity;
  const { groups, sections, defaultSection } = useMemo(
    () => settingsSections(contributed, departureCommunity),
    [contributed, departureCommunity],
  );
  const [selected, setSelected] = useState(defaultSection);
  const departureFocus = useRef(false);
  useLayoutEffect(() => {
    if (selected !== "profile" || !departureFocus.current) return;
    departureFocus.current = false;
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [selected]);
  useEffect(() => {
    if (
      departure &&
      (selected !== "leave-community" ||
        departure.viewer !== client.viewer ||
        (client.selected !== null &&
          client.selected !== departure.community.id))
    )
      setDeparture(null);
  }, [client.selected, client.viewer, departure, selected]);
  const requestedSection =
    navigation?.target.kind === "settings"
      ? (navigation.target.section ?? defaultSection)
      : undefined;
  useEffect(() => {
    if (
      requestedSection &&
      sections.some((section) => section.id === requestedSection)
    )
      setSelected(requestedSection);
    else if (!sections.some((section) => section.id === selected)) {
      setSelected(defaultSection);
      if (requestedSection === selected) onSection?.(defaultSection);
    }
  }, [defaultSection, onSection, requestedSection, selected, sections]);
  useEffect(() => {
    if (requestedSection === selected)
      navigation?.complete({ status: "opened" });
  }, [navigation, requestedSection, selected]);
  const { configuration, activation, busy, error, refreshError } =
    useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const ready = configuration.status === "ready" ? configuration : undefined;
  const catalog = ready?.catalog;
  const externalPluginsPaused = ready?.externalPluginsPaused;
  const [activationAttempt, setActivationAttempt] = useState<{
    id: string;
    revision: string;
  }>();
  const attemptedPlugin = catalog?.plugins.find(
    (plugin) =>
      plugin.manifest.id === activationAttempt?.id &&
      plugin.revision === activationAttempt?.revision &&
      plugin.enabled,
  );
  const attemptedRunning =
    attemptedPlugin && activation[attemptedPlugin.manifest.id];
  const activationFailure =
    attemptedRunning?.revision === activationAttempt?.revision
      ? attemptedRunning?.error
      : null;
  const togglePlugin = (plugin: PluginInfo) => {
    if (
      busy ||
      (!plugin.enabled &&
        restrictedPlugin(plugin) &&
        adminAccess?.status(plugin.manifest.id) !== "allowed")
    )
      return;
    setActivationAttempt(
      plugin.enabled
        ? undefined
        : { id: plugin.manifest.id, revision: plugin.revision },
    );
    void plugins.change(
      plugin.enabled ? "disable" : "enable",
      plugin.manifest.id,
    );
  };
  const [pluginFilter, setPluginFilter] = useState<"all" | "essentials">("all");
  const [pluginQuery, setPluginQuery] = useState("");
  const pluginSearch = useRef<HTMLElement>(null);
  const pluginFiltersActive =
    pluginFilter !== "all" || pluginQuery.trim() !== "";
  const reducedMotion = useReducedMotion();
  const listMotion = {
    layout: reducedMotion ? (false as const) : ("position" as const),
    initial: reducedMotion ? (false as const) : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    ...(reducedMotion ? {} : { exit: { opacity: 0 } }),
    transition: {
      duration: reducedMotion ? 0 : 0.16,
      layout: { type: "spring" as const, stiffness: 420, damping: 38 },
    },
  };
  const layoutMotion = {
    layout: listMotion.layout,
    transition: listMotion.transition,
  };
  const coreGroup = useMemo(
    () =>
      groupPlugins(catalog?.plugins ?? []).find((group) => group.id === "core"),
    [catalog?.plugins],
  );
  const pluginGroups = useMemo(() => {
    const query = pluginQuery.trim().toLowerCase();
    return groupPlugins(
      (catalog?.plugins ?? []).filter(
        (plugin) =>
          !isCorePlugin(plugin) &&
          (pluginFilter === "all" || isEssentialPlugin(plugin)) &&
          [
            plugin.manifest.name,
            plugin.manifest.id,
            plugin.manifest.description,
            ...(plugin.manifest.discovery?.tags ?? []),
          ].some((value) => value?.toLowerCase().includes(query)),
      ),
    );
  }, [catalog?.plugins, pluginFilter, pluginQuery]);
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [updatingPluginId, setUpdatingPluginId] = useState<string>();
  const [pluginImportActions, setPluginImportActions] =
    useState<HTMLSpanElement | null>(null);
  const pluginTrigger = useRef<HTMLButtonElement>(null);
  const restorePluginFocus = useRef(false);
  const pluginSection = useRef<HTMLElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const detailsClose = useRef<HTMLButtonElement>(null);
  const selectedPlugin = catalog?.plugins.find(
    (plugin) => plugin.manifest.id === selectedPluginId,
  );
  const showingDetails = selected === "plugins" && !!selectedPlugin;
  const visibleReturn = (target: HTMLElement | null) =>
    covered(pluginSection.current) ? (detailsClose.current ?? target) : target;
  useEffect(() => {
    if (selected !== "plugins") setSelectedPluginId(undefined);
  }, [selected]);
  useEffect(() => {
    const element = layout.current;
    if (!showingDetails || !element) return;
    // Resizing can hide the focused catalog control; keep focus in details.
    const observer = new ResizeObserver(() => {
      const active = document.activeElement;
      const details = detailsClose.current?.closest("aside");
      if (
        covered(pluginSection.current) &&
        (active === document.body ||
          (!!active && element.contains(active) && !details?.contains(active)))
      )
        detailsClose.current?.focus();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [showingDetails]);
  useEffect(() => {
    if (selectedPluginId && catalog && !selectedPlugin) {
      pluginSection.current?.focus();
      setSelectedPluginId(undefined);
    }
  }, [catalog, selectedPlugin, selectedPluginId]);
  const closePluginDetails = () => {
    restorePluginFocus.current = true;
    setSelectedPluginId(undefined);
  };
  useLayoutEffect(() => {
    if (!selectedPlugin && restorePluginFocus.current) {
      restorePluginFocus.current = false;
      const visible = [coreGroup, ...pluginGroups].some((group) =>
        group?.plugins.some(
          (plugin) =>
            plugin.manifest.id === pluginTrigger.current?.dataset.pluginId,
        ),
      );
      (visible ? pluginTrigger.current : pluginSection.current)?.focus();
    }
  }, [selectedPlugin, coreGroup, pluginGroups]);
  const selectedRunning = selectedPlugin
    ? activation[selectedPlugin.manifest.id]
    : undefined;
  const selectedFailure = selectedPlugin
    ? (selectedPlugin.error ??
      (selectedRunning?.revision === selectedPlugin.revision
        ? selectedRunning.error
        : null))
    : null;
  const renderPluginGroup = (
    group: ReturnType<typeof groupPlugins>[number],
  ) => {
    const core = group.id === "core";
    const Group = core ? CorePluginGroup : SettingsGroup;
    const Target = core ? SurfaceButton : "button";
    return (
      <PluginListEntry
        {...listMotion}
        className={core ? styles.pluginCoreSection : undefined}
        role="region"
        aria-label={core ? "Core plugins" : undefined}
        aria-labelledby={core ? undefined : `plugin-category-${group.id}`}
        key={group.id}
      >
        {!core && (
          <InlineHeader
            id={`plugin-category-${group.id}`}
            title={
              <span className={styles.pluginCategoryTitle}>
                <span>{group.label}</span>
                <span className={styles.pluginCount}>
                  {group.plugins.length}
                  <span className="sr-only">
                    {group.plugins.length === 1 ? " plugin" : " plugins"}
                  </span>
                </span>
              </span>
            }
          />
        )}
        <Group>
          <AnimatePresence initial={false} mode="popLayout" propagate>
            {group.plugins.map((plugin) => {
              const id = plugin.manifest.id;
              const active = id === selectedPluginId;
              const access = pluginAccess(plugin);
              const accessReason = restrictedPlugin(plugin)
                ? accessMessage(plugin, access)
                : null;
              const running = activation[id];
              const failure =
                plugin.error ??
                (running?.revision === plugin.revision ? running.error : null);
              const name = (
                <span className={styles.pluginName}>
                  <span>{plugin.manifest.name}</span>
                  {plugin.source === "bundled" && (
                    <CheckCircleIcon
                      size={14}
                      strokeWidth={2.5}
                      aria-hidden="true"
                    />
                  )}
                  {isEssentialPlugin(plugin) && (
                    <SparklesIcon
                      size={14}
                      role="img"
                      aria-label="Essential"
                      aria-hidden={false}
                      title="Essential"
                    />
                  )}
                </span>
              );
              return (
                <PluginListEntry key={id} {...listMotion}>
                  <article
                    className={styles.plugin}
                    data-core={core || undefined}
                  >
                    <Target
                      ref={
                        active
                          ? (target: HTMLButtonElement | null) => {
                              if (target) pluginTrigger.current = target;
                            }
                          : undefined
                      }
                      type="button"
                      data-plugin-id={id}
                      data-access-state={
                        plugin.enabled && accessReason ? "" : undefined
                      }
                      data-updatable={
                        (plugin.source === "external" && !!plugins.imports) ||
                        undefined
                      }
                      className={styles.pluginRow}
                      data-enabled={plugin.enabled}
                      aria-label={`View ${plugin.manifest.name} details`}
                      aria-describedby={
                        [
                          plugin.manifest.description
                            ? `plugin-description-${id}`
                            : null,
                          plugin.source === "external" && plugin.publisher
                            ? `plugin-publisher-${id}`
                            : null,
                          isEssentialPlugin(plugin)
                            ? `plugin-essential-${id}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                      aria-expanded={active}
                      aria-controls={active ? "plugin-details" : undefined}
                      onClick={(event) => {
                        pluginTrigger.current = event.currentTarget;
                        if (!active) setActivationAttempt(undefined);
                        setSelectedPluginId(active ? undefined : id);
                      }}
                    >
                      {isEssentialPlugin(plugin) && (
                        <span id={`plugin-essential-${id}`} className="sr-only">
                          Essential
                        </span>
                      )}
                      {core ? (
                        <>
                          <PluginIcon plugin={plugin} />
                          {name}
                          <span
                            id={`plugin-description-${id}`}
                            className={styles.pluginCoreDescription}
                          >
                            {plugin.manifest.description}
                          </span>
                        </>
                      ) : (
                        <ChoiceRow
                          leading={<PluginIcon plugin={plugin} />}
                          label={name}
                          description={
                            plugin.manifest.description ? (
                              <span id={`plugin-description-${id}`}>
                                {plugin.manifest.description}
                              </span>
                            ) : undefined
                          }
                        />
                      )}
                      {plugin.source === "external" && (
                        <span id={`plugin-publisher-${id}`}>
                          <PluginProvenance
                            source={plugin.source}
                            publisher={plugin.publisher}
                            className={styles.pluginRowAuthor}
                          />
                        </span>
                      )}
                    </Target>
                    <div className={styles.pluginRowAction}>
                      {plugin.enabled && accessReason && (
                        <span className="text-caption text-muted self-center">
                          {access === "checking" ? "Checking…" : "Unavailable"}
                        </span>
                      )}
                      {plugin.source === "external" &&
                        plugins.imports &&
                        catalog && (
                          <Button
                            size="sm"
                            aria-label={`Update ${plugin.manifest.name}`}
                            data-plugin-update-id={id}
                            disabled={busy}
                            onClick={() => setUpdatingPluginId(id)}
                          >
                            Update
                          </Button>
                        )}
                      {isRequiredPlugin(plugin) ? (
                        <Button variant="outline" size="sm" disabled>
                          Required
                        </Button>
                      ) : (
                        <Tooltip
                          content={accessReason}
                          {...(accessReason ? {} : { open: false })}
                          disableHoverablePopup
                        >
                          <Button
                            variant={
                              plugin.enabled
                                ? "subtle"
                                : accessReason
                                  ? "outline"
                                  : "prominent"
                            }
                            size="sm"
                            aria-label={`${pluginActionLabel(plugin, access)} ${plugin.manifest.name}`}
                            disabled={
                              busy ||
                              (!plugin.enabled &&
                                restrictedPlugin(plugin) &&
                                access !== "allowed")
                            }
                            loading={
                              !plugin.enabled &&
                              restrictedPlugin(plugin) &&
                              access === "checking"
                            }
                            aria-describedby={
                              accessReason ? `plugin-access-${id}` : undefined
                            }
                            focusableWhenDisabled
                            onClick={() => togglePlugin(plugin)}
                          >
                            {pluginActionLabel(plugin, access)}
                          </Button>
                        </Tooltip>
                      )}
                    </div>
                  </article>
                  {accessReason && (
                    <p id={`plugin-access-${id}`} className="sr-only">
                      {accessReason}
                    </p>
                  )}
                  {failure && (
                    <p
                      className={`${styles.pluginRowError} error text-body-sm`}
                    >
                      {failure}
                    </p>
                  )}
                </PluginListEntry>
              );
            })}
          </AnimatePresence>
        </Group>
      </PluginListEntry>
    );
  };
  const authorizePluginGit = async (repository: string) => {
    const connection = communities.relay.snapshot();
    return connection.status === "ready"
      ? ((await connection.session.authorizeGit?.(repository)) ?? null)
      : null;
  };
  return (
    <div
      className={`${styles.root} ${navigationPane ? styles.navigationPane : ""}`}
    >
      <Panel
        aria-label={navigationPane ? "Settings" : undefined}
        aria-labelledby={navigationPane ? undefined : "settings-title"}
      >
        {/* Keep announcements outside filtered rows and the covered narrow catalog. */}
        <div
          role={selected === "plugins" ? "alert" : undefined}
          className="sr-only"
        >
          {selected === "plugins" && activationFailure && attemptedPlugin
            ? `${attemptedPlugin.manifest.name}: ${activationFailure}`
            : selected === "plugins" && selectedFailure && selectedPlugin
              ? `${selectedPlugin.manifest.name}: ${selectedFailure}`
              : null}
        </div>
        <div
          ref={layout}
          className={styles.layout}
          data-plugin-detail={showingDetails ? "" : undefined}
        >
          <aside className={styles.sidebar}>
            <div className={styles.sidebarHeader}>
              <h1 id="settings-title" className="m-0 text-label">
                Settings
              </h1>
            </div>
            <nav aria-label="Settings sections" className={styles.navigation}>
              {groups.map((group) => (
                <NavigationSection key={group.id} label={group.label}>
                  {group.sections.map(({ id, label, icon: Icon }) => (
                    <NavigationItem
                      label={label}
                      icon={Icon && <Icon aria-hidden="true" size={18} />}
                      selected={selected === id}
                      type="button"
                      key={id}
                      aria-current={selected === id ? "page" : undefined}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        if (onSection) onSection(id);
                        else setSelected(id);
                      }}
                    />
                  ))}
                </NavigationSection>
              ))}
            </nav>
          </aside>
          <div className={`${styles.detail} buzz-settings-page`}>
            {navigationPane && <h1 className="sr-only">Settings</h1>}
            <div hidden={selected !== "notifications"}>
              <NotificationSettings
                notifications={notifications}
                active={selected === "notifications"}
              />
            </div>
            <div hidden={selected !== "appearance"}>
              <AppearanceSettings
                appearance={appearance}
                active={selected === "appearance"}
              />
            </div>
            <div hidden={selected !== "shortcuts"}>
              <ShortcutSettings
                shortcuts={shortcuts}
                bindings={shortcutBindings}
                plugins={plugins}
              />
            </div>
            <div hidden={selected !== "agents"}>
              <AgentSettings agents={agents} active={selected === "agents"} />
            </div>
            <div hidden={selected !== "updates"}>
              <UpdateSettings
                updates={updates}
                active={selected === "updates"}
              />
            </div>
            {contributed.map(
              (card) =>
                selected === card.key && (
                  <OwnedContribution
                    key={card.key}
                    entry={card}
                    registry={cards}
                  >
                    {(entry, active) => {
                      const Card = entry.component;
                      return (
                        <Card
                          active={active}
                          {...(!card.group && selectedCommunity
                            ? { community: selectedCommunity }
                            : {})}
                        />
                      );
                    }}
                  </OwnedContribution>
                ),
            )}
            {departureCommunity && selected === "leave-community" && (
              <CommunityDepartureSettings
                key={`${client.viewer}:${departureCommunity.id}`}
                communities={communities}
                community={departureCommunity}
                onPending={(pending) => {
                  onDeparturePending?.(pending);
                  setDeparture(
                    pending
                      ? { community: departureCommunity, viewer: client.viewer }
                      : null,
                  );
                }}
                onRemoved={() => {
                  departureFocus.current = true;
                  if (onSection) onSection("profile");
                  else setSelected("profile");
                }}
              />
            )}
            <div hidden={selected !== "profile"}>
              <ProfileSettings
                key={`${client.viewer}:${selectedCommunity?.id ?? "local"}`}
                communities={communities}
                community={selectedCommunity}
              />
            </div>
            {selected === "identity" && (
              <IdentitySettings
                key={client.viewer}
                viewer={client.viewer}
                identity={identity}
              />
            )}
            {developerMode && (
              <div hidden={selected !== "developer"}>
                <DeveloperSettings relay={communities.relay} />
              </div>
            )}
            <div hidden={selected !== "plugins"}>
              <section
                ref={pluginSection}
                tabIndex={-1}
                aria-labelledby="plugin-settings-title"
              >
                <motion.div {...layoutMotion} className={styles.pluginHeading}>
                  <Header
                    id="plugin-settings-title"
                    title="Manage plugins"
                    actions={
                      plugins.imports && catalog ? (
                        <span ref={setPluginImportActions} />
                      ) : undefined
                    }
                  />
                </motion.div>
                <AnimatePresence initial={false} mode="popLayout">
                  {coreGroup && renderPluginGroup(coreGroup)}
                </AnimatePresence>
                {catalog && (
                  <motion.div
                    {...layoutMotion}
                    className={styles.pluginToolbar}
                  >
                    <motion.div {...layoutMotion}>
                      <Tabs
                        variant="panel"
                        label="Plugin filters"
                        items={[
                          {
                            value: "all",
                            label: "All plugins",
                            panelId: "plugin-results-all",
                          },
                          {
                            value: "essentials",
                            label: "Essentials",
                            panelId: "plugin-results-essentials",
                          },
                        ]}
                        value={pluginFilter}
                        onValueChange={setPluginFilter}
                      />
                    </motion.div>
                    <motion.div
                      {...layoutMotion}
                      className={styles.pluginSearch}
                    >
                      <SearchField
                        inputRef={pluginSearch}
                        label="Search plugins"
                        placeholder="Search plugins…"
                        value={pluginQuery}
                        onValueChange={setPluginQuery}
                      />
                    </motion.div>
                  </motion.div>
                )}
                {catalog ? (
                  <PluginImport
                    actionTarget={pluginImportActions}
                    plugins={plugins}
                    catalog={catalog}
                    busy={busy}
                    authorizeGit={authorizePluginGit}
                    returnFocus={() => visibleReturn(null)}
                  />
                ) : configuration.status === "recovery" ? (
                  <RecoveryScreen plugins={plugins} />
                ) : (
                  <p role="status">
                    Plugin settings are unavailable. Profile and Appearance
                    still work.
                  </p>
                )}
                {catalog && updatingPluginId && (
                  <PluginImport
                    updateId={updatingPluginId}
                    plugins={plugins}
                    catalog={catalog}
                    busy={busy}
                    authorizeGit={authorizePluginGit}
                    onClosed={() => setUpdatingPluginId(undefined)}
                    returnFocus={() =>
                      visibleReturn(
                        Array.from(
                          pluginSection.current?.querySelectorAll<HTMLButtonElement>(
                            "[data-plugin-update-id]",
                          ) ?? [],
                        ).find(
                          (button) =>
                            button.dataset.pluginUpdateId === updatingPluginId,
                        ) ?? pluginSection.current,
                      )
                    }
                  />
                )}
                <div>
                  <div>
                    {externalPluginsPaused && (
                      <p role="status" className="text-body-sm text-subtle">
                        External plugins are paused for this launch. Your saved
                        enabled settings are unchanged; you can still manage
                        plugins here.
                      </p>
                    )}
                    {selected === "plugins" && refreshError && (
                      <ToastNotice
                        title="Plugin settings couldn’t refresh"
                        description={`Showing the last available configuration; retrying automatically. ${refreshError}`}
                      />
                    )}
                    {selected === "plugins" && error && (
                      <ToastNotice
                        title="Plugin change wasn’t confirmed"
                        description={`Check the current settings before trying again. ${error}`}
                        onDismiss={plugins.dismissError}
                        closeLabel="Dismiss"
                      />
                    )}
                  </div>
                  {catalog &&
                    (["all", "essentials"] as const).map((filter) => (
                      <div
                        key={filter}
                        hidden={filter !== pluginFilter}
                        className={
                          filter === pluginFilter
                            ? styles.pluginCategories
                            : undefined
                        }
                        role="tabpanel"
                        id={`plugin-results-${filter}`}
                        aria-labelledby={`plugin-results-${filter}-tab`}
                      >
                        {filter === pluginFilter && (
                          <>
                            {pluginGroups.length === 0 && (
                              <EmptyState
                                icon={<SquaresFourIcon size={24} />}
                                title={
                                  pluginFiltersActive
                                    ? coreGroup
                                      ? "No other plugins match"
                                      : "No plugins match"
                                    : coreGroup
                                      ? "No other plugins"
                                      : "No plugins yet"
                                }
                                description={
                                  pluginFiltersActive
                                    ? "Try another search or show all plugins."
                                    : "Additional plugins will appear here."
                                }
                                action={
                                  pluginFiltersActive ? (
                                    <Button
                                      variant="subtle"
                                      onClick={() => {
                                        setPluginQuery("");
                                        setPluginFilter("all");
                                        pluginSearch.current?.focus();
                                      }}
                                    >
                                      Clear filters
                                    </Button>
                                  ) : undefined
                                }
                              />
                            )}
                            <AnimatePresence initial={false} mode="popLayout">
                              {pluginGroups.map(renderPluginGroup)}
                            </AnimatePresence>
                          </>
                        )}
                      </div>
                    ))}
                </div>
              </section>
            </div>
          </div>
          {showingDetails && selectedPlugin && (
            <PluginDetails
              key={selectedPlugin.manifest.id}
              plugin={selectedPlugin}
              failure={selectedFailure}
              busy={busy}
              access={pluginAccess(selectedPlugin)}
              onCheckAccess={() =>
                adminAccess?.retry(selectedPlugin.manifest.id)
              }
              plugins={plugins}
              onToggle={() => togglePlugin(selectedPlugin)}
              close={detailsClose}
              onClose={closePluginDetails}
            />
          )}
        </div>
      </Panel>
    </div>
  );
}
