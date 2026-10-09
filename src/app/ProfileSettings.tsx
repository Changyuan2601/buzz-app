import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import type { Identity } from "../features/identity/service";
import { PrivateKey } from "../features/identity/PrivateKey";
import { SignOutDialog } from "../features/identity/SignOut";
import { profileDefault } from "../features/communities/profile-default";
import { AvatarEditor } from "../features/profiles/AvatarEditor";
import { Button } from "../shared/design-system/ui/Button";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { CopyIcon } from "../shared/design-system/icons";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { npubEncode } from "nostr-tools/nip19";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import styles from "./ProfileSettings.module.css";
import type {
  Communities,
  PersonalProfile,
} from "../features/communities/service";
import {
  canSaveProfile,
  ProfileFields,
  profilesEqual,
} from "../features/communities/ProfileFields";
import * as communityApi from "../features/communities/api";
import type { Membership } from "../features/communities/service";

type LoadedProfile = Awaited<ReturnType<typeof communityApi.inspectProfile>>;

const profileSaveGenerations = new WeakMap<Communities, number>();
function beginProfileSave(communities: Communities) {
  const generation = (profileSaveGenerations.get(communities) ?? 0) + 1;
  profileSaveGenerations.set(communities, generation);
  return generation;
}
function isCurrentProfileSave(communities: Communities, generation: number) {
  return profileSaveGenerations.get(communities) === generation;
}

export function ProfileSettings({
  communities,
  community,
  identity,
  active = true,
}: {
  communities: Communities;
  community?: Membership | undefined;
  identity?: Identity | undefined;
  active?: boolean;
}) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const pendingFocus = useRef<HTMLInputElement | null>(null);
  const actionsRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // Capture focus before the conditional actions leave the DOM.
    return () => {
      if (node.contains(document.activeElement))
        pendingFocus.current =
          node.closest("form")?.querySelector<HTMLInputElement>("input") ??
          null;
    };
  }, []);
  useLayoutEffect(() => {
    // The form fields may still be disabled during ref cleanup. Wait until
    // React has committed their enabled state; unmounting runs no handoff.
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.isConnected) target.focus();
  });
  const [loaded, setLoaded] = useState<LoadedProfile | null>(null);
  const [loadStatus, setLoadStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >(community ? "idle" : "ready");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<PersonalProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);
  const copyAttempt = useRef(0);
  // loadAttempt is an explicit recovery trigger.
  useEffect(() => {
    void loadAttempt;
    setDraft(null);
    setLoaded(null);
    setSaved(false);
    setLoadError("");
    setError("");
    if (!community) {
      setLoadStatus("ready");
      return;
    }
    if (!client.relayAvailable) return;
    let current = true;
    setLoadStatus("loading");
    void communityApi.inspectProfile(community.id).then(
      (result) => {
        if (!current) return;
        setLoaded(result);
        setLoadStatus("ready");
      },
      (reason) => {
        if (!current) return;
        setLoadStatus("error");
        setLoadError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [community, loadAttempt, client.relayAvailable]);
  const persisted =
    community && loaded?.exists ? loaded.profile : client.profile;
  const profile = draft ?? persisted;
  const hasChanges = draft !== null && !profilesEqual(draft, persisted);
  const npub = client.viewer ? npubEncode(client.viewer) : "";
  async function copyIdentity(value: string, label: string) {
    const attempt = ++copyAttempt.current;
    setCopyStatus(null);
    try {
      await navigator.clipboard.writeText(value);
      if (attempt === copyAttempt.current)
        setCopyStatus({ message: `${label} copied.`, failed: false });
    } catch {
      if (attempt === copyAttempt.current)
        setCopyStatus({
          message: `Couldn’t copy ${label.toLowerCase()}. Select it and copy manually.`,
          failed: true,
        });
    }
  }
  return (
    <section aria-labelledby="profile-settings-title">
      <Header
        id="profile-settings-title"
        title="Profile"
        subtitle={
          community
            ? "Update this community’s profile. Other community profiles stay unchanged."
            : "Used for new communities. Existing community profiles stay unchanged."
        }
      />
      <div>
        {client.status !== "ready" ? (
          <p role="status">
            {client.status === "loading"
              ? "Opening your local identity…"
              : "Your local identity is unavailable. Connect your identity to edit your profile."}
          </p>
        ) : community && !client.relayAvailable ? (
          <p role="status">
            Community profiles are not available in this build yet.
          </p>
        ) : community && loadStatus !== "ready" ? (
          <div>
            {loadStatus === "error" ? (
              <>
                <p role="alert" className="error">
                  Your profile in {community.name} couldn’t be loaded.{" "}
                  {loadError}
                </p>
                <Button
                  type="button"
                  onClick={() => setLoadAttempt((value) => value + 1)}
                >
                  Retry loading profile
                </Button>
              </>
            ) : (
              <p role="status">Loading your profile in {community.name}…</p>
            )}
          </div>
        ) : (
          <SettingsGroup layout="form">
            <section aria-label="Profile preview" className={styles.preview}>
              <div>
                <AvatarEditor
                  size="compact"
                  value={profile.picture}
                  name={profile.name}
                  community={community?.id}
                  disabled={saving}
                  onBusyChange={setUploading}
                  onChange={(picture) => {
                    setDraft({ ...profile, picture });
                    setSaved(false);
                    setError("");
                  }}
                />
              </div>
              <div className={styles.previewCopy}>
                <h3 className="text-label-sm">
                  {profile.name.trim() || "Your profile"}
                </h3>
                {profile.about?.trim() ? (
                  <p className={`${styles.about} text-body-sm text-muted`}>
                    {profile.about.trim()}
                  </p>
                ) : null}
              </div>
            </section>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  saving ||
                  uploading ||
                  !hasChanges ||
                  !canSaveProfile(profile) ||
                  (community && !loaded)
                )
                  return;
                const next = {
                  ...profile,
                  name: profile.name.trim(),
                  about: profile.about?.trim() ?? "",
                };
                // Capture once before async work: selection may change during Save.
                const connection = communities.relay.snapshot();
                const session =
                  community &&
                  communities.snapshot().selected === community.id &&
                  connection.viewer === client.viewer &&
                  connection.status === "ready"
                    ? connection.session
                    : undefined;
                const inspect = (id: string) =>
                  session
                    ? communityApi.inspectProfile(id, session)
                    : communityApi.inspectProfile(id);
                const saveGeneration = beginProfileSave(communities);
                setSaving(true);
                setSaved(false);
                setError("");
                void (async () => {
                  try {
                    if (community && loaded) {
                      // Preserve fields outside this editor even if another client edited them.
                      const latest = await inspect(community.id);
                      if (!mounted.current) return;
                      await communityApi.publishProfile(
                        community.id,
                        next,
                        latest.existing,
                      );
                      // Once dispatched, finish on this session even if Settings closes.
                      const confirmed = await inspect(community.id);
                      if (
                        !confirmed.exists ||
                        !profilesEqual(confirmed.profile, next)
                      )
                        throw new Error(
                          "Your profile change is not current. Your edits are retained; save again to retry.",
                        );
                      setLoaded(confirmed);
                    }
                    if (isCurrentProfileSave(communities, saveGeneration))
                      communities.saveProfile(
                        profileDefault(
                          next,
                          communities.snapshot().profile,
                          community?.id,
                        ),
                      );
                    setDraft(null);
                    setSaved(true);
                  } catch (reason) {
                    if (mounted.current)
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      );
                  } finally {
                    if (mounted.current) setSaving(false);
                  }
                })();
              }}
            >
              <ProfileFields
                profile={profile}
                showAvatar={false}
                disabled={saving}
                onChange={(next) => {
                  setDraft(next);
                  setSaved(false);
                  setError("");
                }}
              />
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              {hasChanges && (
                <div
                  ref={actionsRef}
                  className="mt-6 flex flex-wrap items-center justify-end gap-3"
                >
                  <Button
                    type="button"
                    disabled={saving || uploading}
                    onClick={() => {
                      setDraft(null);
                      setSaved(false);
                      setError("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    loading={saving}
                    disabled={uploading || !canSaveProfile(profile)}
                    variant="primary"
                  >
                    Save
                  </Button>
                </div>
              )}
              {saved && (
                <ToastNotice
                  title="Profile updated"
                  tone="success"
                  timeout={5000}
                  onDismiss={() => setSaved(false)}
                />
              )}
            </form>
          </SettingsGroup>
        )}
        {client.viewer && (
          <section
            aria-labelledby="identity-settings-title"
            className="mt-section-gap"
          >
            <InlineHeader
              id="identity-settings-title"
              title="Identity details"
              subtitle="Your identity is shared across communities. Public keys are safe to share."
            />
            <SettingsGroup>
              {(
                [
                  ["Public key (hex)", "Public key", client.viewer],
                  ["Nostr address (npub)", "Nostr address", npub],
                ] as const
              ).map(([label, copyLabel, value]) => (
                <PreferenceRow
                  key={label}
                  title={label}
                  subtitle={
                    <code className={`text-mono ${styles.identityValue}`}>
                      {value}
                    </code>
                  }
                  trailing={
                    <Tooltip content={`Copy ${copyLabel.toLowerCase()}`}>
                      <IconButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Copy ${copyLabel.toLowerCase()}`}
                        icon={<CopyIcon aria-hidden="true" />}
                        onClick={() => void copyIdentity(value, copyLabel)}
                      />
                    </Tooltip>
                  }
                />
              ))}
            </SettingsGroup>
            {identity && active && (
              <div className="mt-6">
                <SettingsGroup layout="form">
                  {/* One key widget at a time; the dialog brings its own. */}
                  {!signingOut && <PrivateKey identity={identity} />}
                </SettingsGroup>
                <SettingsGroup>
                  <PreferenceRow
                    title="Sign out of Buzz"
                    subtitle="Remove your private key from this device. Also ends Builderlab and hosted community logins."
                    trailing={
                      <Button type="button" onClick={() => setSigningOut(true)}>
                        Sign out of Buzz
                      </Button>
                    }
                  />
                </SettingsGroup>
                {signingOut && (
                  <SignOutDialog
                    identity={identity}
                    onClose={() => setSigningOut(false)}
                  />
                )}
              </div>
            )}
            {copyStatus && (
              <ToastNotice
                title={
                  copyStatus.failed
                    ? "Identity wasn’t copied"
                    : copyStatus.message
                }
                {...(copyStatus.failed
                  ? { description: copyStatus.message }
                  : {})}
                tone={copyStatus.failed ? "error" : "success"}
                timeout={copyStatus.failed ? 0 : 5000}
                onDismiss={() => setCopyStatus(null)}
              />
            )}
          </section>
        )}
      </div>
    </section>
  );
}
