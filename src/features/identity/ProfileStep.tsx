import { useState } from "react";
import { type inspectProfile, publishProfile } from "../communities/api";
import type { FoundCommunity } from "../communities/find-community";
import { profileDefault } from "../communities/profile-default";
import {
  canSaveProfile,
  ProfileFields,
  profilesEqual,
} from "../communities/ProfileFields";
import type { Communities, PersonalProfile } from "../communities/service";
import { readErrorKind } from "../relay/errors";
import { Button } from "../../shared/design-system/ui/Button";
import { WireframePanel } from "./Wireframe";

/**
 * First-run profile, shown once the first membership is saved and before the
 * gate lifts. Continue publishes a kind 0 to that one relay through the same
 * route Settings → Profile uses and keeps the result as the local default;
 * Skip enters the app with the membership alone, as before this step existed.
 */
export function ProfileStep({
  found,
  read,
  defaultName,
  communities,
  onDone,
}: {
  found: Pick<FoundCommunity, "url" | "host">;
  /** The admission read that joined the community: prefill and existing fields. */
  read: Awaited<ReturnType<typeof inspectProfile>>;
  /** Suggested display name when the relay holds no profile for this key. */
  defaultName: string;
  communities: Pick<Communities, "snapshot" | "saveProfile">;
  /** Called after a confirmed publish and save, or on Skip. */
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<PersonalProfile>(() =>
    read.exists ? read.profile : { name: defaultName, picture: "", about: "" },
  );
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const canContinue = canSaveProfile(draft) && !busy && !uploading;
  const save = async () => {
    const next = {
      ...draft,
      name: draft.name.trim(),
      about: draft.about?.trim() ?? "",
    };
    setBusy(true);
    setError("");
    try {
      // A relay profile the user kept as-is needs no republish.
      if (!read.exists || !profilesEqual(next, read.profile))
        await publishProfile(found.url, next, read.existing);
      communities.saveProfile(
        profileDefault(next, communities.snapshot().profile, found.url),
      );
    } catch (reason) {
      setError(publishFailure(found.host, reason));
      setBusy(false);
      return;
    }
    onDone();
  };
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (canContinue) void save();
      }}
    >
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-primary"
        >
          Set up your profile
        </h1>
        <p className="mt-2 text-body text-secondary">
          Add a name and avatar. They’ll show up on your messages, reactions,
          and agent handoffs in {found.host}. You can change them any time in
          Settings → Profile.
        </p>
      </div>
      <WireframePanel>
        <ProfileFields
          profile={draft}
          onChange={setDraft}
          disabled={busy}
          community={found.url}
          onBusyChange={setUploading}
          autoFocus
        />
      </WireframePanel>
      {error && (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      )}
      {/* Footer order: secondary first, primary last. */}
      <div className="flex gap-3">
        <Button onClick={onDone} disabled={busy}>
          Skip for now
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!canContinue}
        >
          Continue
        </Button>
      </div>
    </form>
  );
}

/** Classified like the join's read failure; the native route's own messages
 * ("Community request failed (500)", an unconfirmed receipt) are shown as is. */
function publishFailure(host: string, error: unknown) {
  if (readErrorKind(error) === "denied")
    return `${host} no longer admits this key. Skip for now and ask a community administrator.`;
  return error instanceof Error
    ? error.message
    : "Could not reach the relay. Check your connection and try again.";
}
