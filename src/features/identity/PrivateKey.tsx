import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import type { Identity } from "./service";

const MASK = "••••••••••••••••";

// Mount only while Profile is active. Late native results must never repopulate a hidden key.
export function PrivateKey({
  identity,
  onInteraction,
  initiallyRevealed = false,
}: {
  identity: Identity;
  /** Called once the key was revealed or copied, e.g. to gate Sign out. */
  onInteraction?: () => void;
  /**
   * First-run backup page: fetch and show the key on mount in a large well,
   * with Copy as the primary action. Hiding on blur, document hiding and
   * unmount is unchanged, and Reveal is offered again once hidden.
   */
  initiallyRevealed?: boolean;
}) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const clear = () => {
      generation.current++;
      setSecret("");
      setBusy(false);
      setMessage("");
    };
    const visibility = () => {
      if (document.hidden) clear();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", clear);
    return () => {
      generation.current++;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", clear);
    };
  }, []);
  const revealOnMount = useEffectEvent(() => {
    if (initiallyRevealed) void access(false);
  });
  useEffect(() => {
    revealOnMount();
  }, []);
  function hide() {
    generation.current++;
    setSecret("");
    setBusy(false);
    setMessage("");
  }
  async function access(copy: boolean) {
    const current = ++generation.current;
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      const value = secret || (await identity.exportKey());
      if (current !== generation.current) return;
      if (copy) {
        await navigator.clipboard.writeText(value);
        if (current === generation.current)
          setMessage(
            "Private key copied. Keep it somewhere safe; your clipboard now contains it.",
          );
      } else setSecret(value);
      if (current === generation.current) onInteraction?.();
    } catch {
      if (current === generation.current) {
        setFailed(true);
        setMessage(
          copy
            ? "Couldn’t copy your private key. Reveal it to copy manually, or retry."
            : "Couldn’t reveal your private key. Retry when secure storage is available.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <div className={initiallyRevealed ? undefined : "mt-6"}>
      <label
        className="mb-2 block text-label-sm"
        htmlFor={initiallyRevealed ? undefined : "identity-private-key"}
      >
        Private key (nsec)
      </label>
      <p className="text-body-sm text-muted">
        Anyone with this key can act as you. Never share it.
      </p>
      {initiallyRevealed ? (
        // The key well. No mono role is larger than 12px yet, so the body-lg
        // size carries the mono face until one exists.
        <code className="my-3 block select-text break-all font-mono text-body-lg text-primary">
          {secret || MASK}
        </code>
      ) : (
        <Input
          id="identity-private-key"
          readOnly
          value={secret || MASK}
          onFocus={(event) => {
            if (secret) event.currentTarget.select();
          }}
        />
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        <Button
          type="button"
          disabled={busy && !secret}
          onClick={() => (secret ? hide() : void access(false))}
        >
          {secret ? "Hide private key" : "Reveal private key"}
        </Button>
        <Button
          type="button"
          variant={initiallyRevealed ? "primary" : "subtle"}
          disabled={busy}
          onClick={() => void access(true)}
        >
          Copy private key
        </Button>
        {busy && (
          <Button type="button" onClick={hide}>
            Cancel
          </Button>
        )}
      </div>
      {message && <p role={failed ? "alert" : "status"}>{message}</p>}
    </div>
  );
}
