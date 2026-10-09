import { useEffect, useRef, useState } from "react";
import { CircleNotchIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import {
  FindCommunityError,
  findCommunity,
  nativeRelayFetch,
  type FindFailure,
  type FoundCommunity,
  type RelayFetch,
} from "./find-community";

type State =
  | { status: "finding" }
  | { status: "found"; found: FoundCommunity }
  | { status: "failed"; failure: FindFailure };

/** Classified copy; raw transport errors are never shown. */
const FAILURES: Record<FindFailure, { message: string; retry: boolean }> = {
  unreachable: {
    message: "Could not reach the relay. Check your connection and try again.",
    retry: true,
  },
  "not-buzz": { message: "This address isn’t a Buzz community.", retry: false },
  "no-community": {
    message: "No community is set up at this address.",
    retry: false,
  },
};

/**
 * Looks up a community at a canonical secure origin before any session exists.
 * Owns nothing beyond the probe: the caller decides what Join does, and leaving
 * it out keeps Join a disabled placeholder. With a `viewer`, a key the relay
 * already admits reports through `onAlreadyMember` instead of showing Join;
 * without that handler an admitted key still sees Join, which is harmless.
 */
export function FindCommunity({
  url,
  onCancel,
  onJoin,
  onAlreadyMember,
  viewer,
  request = nativeRelayFetch,
  titleId,
}: {
  url: string;
  onCancel: () => void;
  onJoin?: (found: FoundCommunity) => void;
  onAlreadyMember?: (found: FoundCommunity) => void;
  /** The device's human key, hex; enables the signed membership probe. */
  viewer?: string | undefined;
  request?: RelayFetch;
  titleId?: string;
}) {
  const host = new URL(url).host;
  const [state, setState] = useState<State>({ status: "finding" });
  const [adult, setAdult] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const inFlight = useRef<AbortController>(null);
  useEffect(() => {
    if (state.status !== "finding") return;
    const controller = new AbortController();
    inFlight.current = controller;
    findCommunity(url, request, controller.signal, viewer).then(
      (found) => {
        if (controller.signal.aborted) return;
        if (found.member && onAlreadyMember) onAlreadyMember(found);
        else setState({ status: "found", found });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "failed",
          failure:
            error instanceof FindCommunityError ? error.failure : "unreachable",
        });
      },
    );
    return () => controller.abort();
  }, [url, request, viewer, onAlreadyMember, state.status]);
  const cancel = () => {
    // Nothing from this lookup may land after leaving, even if we stay mounted.
    inFlight.current?.abort();
    onCancel();
  };
  const heading = (text: string) => (
    <h1 id={titleId} className="text-title text-primary">
      {text}
    </h1>
  );
  if (state.status === "finding")
    return (
      <>
        {heading("Finding community")}
        <p
          role="status"
          className="flex items-center gap-2 text-body text-secondary"
        >
          <CircleNotchIcon
            size={18}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
          <span className="font-mono">{host}</span>
        </p>
        <div>
          <Button onClick={cancel}>Cancel</Button>
        </div>
      </>
    );
  // Action rows follow the design system's footer order: secondary first, primary last.
  if (state.status === "failed") {
    const { message, retry } = FAILURES[state.failure];
    return (
      <>
        {heading("Couldn’t find community")}
        <p role="alert" className="text-body text-danger">
          {message}
        </p>
        <div className="flex gap-3">
          <Button onClick={cancel}>Cancel</Button>
          {retry && (
            <Button
              variant="primary"
              onClick={() => setState({ status: "finding" })}
            >
              Retry
            </Button>
          )}
        </div>
      </>
    );
  }
  const { found } = state;
  const policy = found.policy;
  const needsAge = policy?.age_attestation_required === true;
  const needsAgreement = Boolean(
    policy?.terms_markdown || policy?.privacy_markdown,
  );
  const consented = (!needsAge || adult) && (!needsAgreement || agreed);
  const label = needsAge || needsAgreement ? "Accept and join" : "Join";
  return (
    <>
      {heading("Join Community")}
      <div className="flex items-center gap-3 rounded-lg border border-standard p-3">
        <Avatar alt="" fallback={found.host} src={found.icon} />
        <p className="m-0 min-w-0 flex-1 truncate font-mono text-label text-primary">
          {found.host}
        </p>
      </div>
      {(needsAge || needsAgreement) && (
        <div className="flex flex-col gap-3">
          {needsAge && (
            <Checkbox
              checked={adult}
              onCheckedChange={setAdult}
              label="I am 18 years of age or older."
            />
          )}
          {needsAgreement && (
            <Checkbox
              checked={agreed}
              onCheckedChange={setAgreed}
              label={
                <>
                  I agree to the Buzz{" "}
                  {policy?.terms_markdown && (
                    <PolicyLink url={url} document="terms">
                      Terms of Service
                    </PolicyLink>
                  )}
                  {policy?.terms_markdown && policy.privacy_markdown && " and "}
                  {policy?.privacy_markdown && (
                    <PolicyLink url={url} document="privacy">
                      Privacy Policy
                    </PolicyLink>
                  )}
                  .
                </>
              }
            />
          )}
        </div>
      )}
      <div className="flex gap-3">
        <Button onClick={cancel}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!onJoin || !consented}
          onClick={() => onJoin?.(found)}
        >
          {onJoin ? label : `${label} — Coming soon`}
        </Button>
      </div>
    </>
  );
}

/** Relay-hosted document pages open outside the app, as in `CommunityDialog`. */
function PolicyLink({
  url,
  document,
  children,
}: {
  url: string;
  document: "terms" | "privacy";
  children: string;
}) {
  return (
    <a
      href={`${url}/api/join-policy/${document}`}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
