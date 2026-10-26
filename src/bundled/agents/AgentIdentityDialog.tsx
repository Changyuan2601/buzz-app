import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useReducedMotion } from "motion/react";
import type { Agent, Agents } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { AgentCreateHeader } from "./AgentCreateHeader";
import styles from "./AgentCreate.module.css";

/** Identity edits share creation's avatar picker, but only publish on Save. */
export function AgentIdentityDialog({
  agent,
  agents,
  onClose,
  finalFocus,
  initialAvatarPicker = false,
}: {
  agent: Agent;
  agents: Agents;
  onClose(): void;
  finalFocus: RefObject<HTMLButtonElement | null>;
  initialAvatarPicker?: boolean;
}) {
  const [name, setName] = useState(agent.name);
  const [picture, setPicture] = useState(agent.picture ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [avatarActive, setAvatarActive] = useState(initialAvatarPicker);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarCanGoBack, setAvatarCanGoBack] = useState(false);
  const pictureChanged = picture !== (agent.picture ?? "");
  const [avatarAction, setAvatarAction] = useState<HTMLDivElement | null>(null);
  const avatarNavigation = useRef<{ back(): void }>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const form = useId();
  const formElement = useRef<HTMLFormElement>(null);
  const resize = useRef<Animation | null>(null);
  const resizeFrom = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const changeAvatarView = useCallback((active: boolean, view: string) => {
    if (resize.current?.playState === "running") {
      const popup =
        formElement.current?.closest<HTMLElement>('[role="dialog"]');
      resizeFrom.current = popup?.getBoundingClientRect().height ?? null;
    }
    setAvatarActive(active);
    setAvatarCanGoBack(view !== "collections" && view !== "selected");
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Measure the modal after each avatar view changes its layout.
  useLayoutEffect(() => {
    const popup = formElement.current?.closest<HTMLElement>('[role="dialog"]');
    const from = resizeFrom.current;
    resize.current?.cancel();
    const to = popup?.getBoundingClientRect().height ?? null;
    resizeFrom.current = to;
    if (
      !popup ||
      from === null ||
      to === null ||
      reducedMotion ||
      document.documentElement.hasAttribute("data-keyboard-navigation")
    )
      return;
    if (from === to) return;
    // Animate the frame itself so text and avatar artwork never stretch.
    resize.current = popup.animate(
      { height: [`${from}px`, `${to}px`] },
      { duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    );
    return () => resize.current?.cancel();
  }, [avatarActive, reducedMotion]);
  const back =
    avatarActive &&
    (!initialAvatarPicker || (avatarCanGoBack && !pictureChanged))
      ? () => avatarNavigation.current?.back()
      : undefined;
  const save = async () => {
    if (
      pending ||
      avatarBusy ||
      (avatarActive && !initialAvatarPicker) ||
      !name.trim() ||
      (initialAvatarPicker && !pictureChanged)
    )
      return;
    setPending(true);
    setError("");
    try {
      await agents.save(agent.key, {
        ...(!initialAvatarPicker && { name: name.trim() }),
        picture: picture || null,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      title="Edit agent"
      size="wide"
      height={avatarActive ? "stable-tall" : "content"}
      chromeSpacing="padded"
      bodyLayout={avatarActive ? "flex" : "flow"}
      initialFocus={initialAvatarPicker ? undefined : nameField}
      finalFocus={finalFocus}
      preventClose={pending}
      dismissOnOutsideClick={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onEscape={() => {
        if (pending) return true;
        if (back || (initialAvatarPicker && avatarCanGoBack)) {
          avatarNavigation.current?.back();
          return true;
        }
        return pending || avatarBusy || (initialAvatarPicker && pictureChanged);
      }}
      leadingActions={
        back && (
          <Button disabled={pending} onClick={back}>
            Back
          </Button>
        )
      }
      actions={
        <>
          <div ref={setAvatarAction} hidden={!avatarActive} />
          {(!avatarActive || initialAvatarPicker) && (
            <>
              <Button disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                form={form}
                loading={pending}
                disabled={
                  pending ||
                  avatarBusy ||
                  !name.trim() ||
                  (initialAvatarPicker && !pictureChanged)
                }
              >
                Save changes
              </Button>
            </>
          )}
        </>
      }
    >
      <form
        id={form}
        ref={formElement}
        className={`${styles.form} ${styles.identityEditForm}`}
        data-avatar-active={avatarActive || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <AgentCreateHeader
          initialAvatarPicker={initialAvatarPicker}
          name={name}
          picture={picture}
          community={agent.relay}
          disabled={pending}
          onBusyChange={setAvatarBusy}
          onChange={(patch) => {
            if (patch.name !== undefined) setName(patch.name);
            if (patch.picture !== undefined) setPicture(patch.picture);
            setError("");
          }}
          nameRef={nameField}
          details={null}
          editing={false}
          avatarNavigationRef={avatarNavigation}
          avatarActionTarget={avatarAction}
          onAvatarActiveChange={changeAvatarView}
        />
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
