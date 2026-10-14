// The New agent card: the avatar, chosen from packs or an image, and the name,
// with a details area the agent type fills in.
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { AvatarEditor } from "../../features/profiles/AvatarEditor";
import { agentAvatars, avatarPacks } from "../../features/agents/avatar-packs";
import { Button } from "../../shared/design-system/ui/Button";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { CloudUploadIcon } from "../../shared/design-system/icons";
import { PackedAgentAvatar } from "./PackedAgentAvatar";
import styles from "./AgentCreate.module.css";

export function AgentCreateHeader({
  name,
  picture,
  disabled,
  onChange,
  community,
  onBusyChange,
  details,
  editing,
  avatarNavigationRef,
  avatarActionTarget,
  onAvatarActiveChange,
  nameRef,
}: {
  name: string;
  picture?: string | undefined;
  disabled: boolean;
  onChange(patch: { name?: string; picture?: string }): void;
  community?: string | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
  /** The type's part of the card, below the name. */
  details: ReactNode;
  /** The details are being edited over the card. */
  editing: boolean;
  avatarNavigationRef?: Ref<{ back(): void }>;
  avatarActionTarget?: HTMLElement | null;
  onAvatarActiveChange?: (active: boolean) => void;
  nameRef?: Ref<HTMLInputElement>;
}) {
  // The header shares AvatarEditor's full-size frame, so it requests the
  // original rather than the thumbnail (see avatar-source.grit).
  const preview = useAvatarPreview(picture ?? "", community);
  const [view, setView] = useState("selected");
  const [movingAvatar, setMovingAvatar] = useState<string>();
  useEffect(() => {
    onAvatarActiveChange?.(view !== "selected");
  }, [view, onAvatarActiveChange]);
  useImperativeHandle(avatarNavigationRef, () => ({
    back() {
      setView(view === "collections" ? "selected" : "collections");
    },
  }));
  const [keyboard, setKeyboard] = useState(false);
  const reducedMotion = useReducedMotion();
  const root = useRef<HTMLFieldSetElement>(null);
  const previousView = useRef(view);
  const options = useRef<HTMLFieldSetElement>(null);
  const [representatives] = useState(() =>
    avatarPacks.map((pack) => {
      const members = agentAvatars.filter(
        (avatar) => avatar.collectionId === pack.id,
      );
      return {
        ...pack,
        avatar: members[Math.floor(Math.random() * members.length)],
      };
    }),
  );
  useLayoutEffect(() => {
    if (previousView.current !== view)
      root.current
        ?.querySelector<HTMLButtonElement>(
          `[data-avatar-view="${view}"] button`,
        )
        ?.focus({ preventScroll: true });
    previousView.current = view;
  }, [view]);
  const [gridSize, setGridSize] = useState({ width: 768, height: 432, gap: 8 });
  useLayoutEffect(() => {
    if (view === "selected" || view === "collections" || view === "image")
      return;
    const element = options.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setGridSize({
          width: Math.max(1, entry.contentRect.width),
          height: Math.max(1, entry.contentRect.height),
          gap: Number.parseFloat(getComputedStyle(element).gap) || 0,
        });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);
  const choices = agentAvatars.filter((avatar) => avatar.collectionId === view);
  let columns = 1;
  let largestTile = 0;
  for (let candidate = 1; candidate <= choices.length; candidate++) {
    const rows = Math.ceil(choices.length / candidate);
    const size = Math.min(
      (gridSize.width - (candidate - 1) * gridSize.gap) / candidate,
      (gridSize.height - (rows - 1) * gridSize.gap) / rows,
    );
    if (size > largestTile) {
      columns = candidate;
      largestTile = size;
    }
  }
  const selected = agentAvatars.find((avatar) => avatar.url === picture);
  const transition = {
    duration: reducedMotion || keyboard ? 0 : 0.3,
    ease: [0.22, 1, 0.36, 1] as const,
  };
  const artwork = (avatar: (typeof agentAvatars)[number]) => (
    <motion.div
      layoutId={avatar.id}
      initial={false}
      transition={avatar.id === movingAvatar ? transition : { duration: 0 }}
      className={styles.artwork}
      aria-hidden="true"
    >
      <PackedAgentAvatar avatar={avatar} />
    </motion.div>
  );
  return (
    <LayoutGroup>
      <fieldset
        ref={root}
        aria-label="Agent avatar"
        data-avatar-active={view !== "selected" || undefined}
        className={styles.identity}
        data-editing={editing || undefined}
        onPointerDown={() => setKeyboard(false)}
        onKeyDown={() => setKeyboard(true)}
      >
        <div className={styles.cover} data-view={view}>
          <motion.div
            key={view}
            data-avatar-view={view}
            className={styles.view}
            initial={false}
          >
            {view === "selected" ? (
              <motion.div
                className={styles.choice}
                initial={false}
                animate={{
                  scale: editing ? 0.65 : 1,
                  y: editing ? -112 : 0,
                }}
                transition={transition}
                inert={editing}
              >
                {selected ? (
                  artwork(selected)
                ) : preview ? (
                  <motion.div
                    layoutId="agent-uploaded-avatar"
                    transition={transition}
                    className={`${styles.artwork} ${styles.uploaded}`}
                    data-avatar-shape="squircle"
                  >
                    <img src={preview} alt="Agent avatar" />
                  </motion.div>
                ) : (
                  <span className="text-heading">
                    {name.trim().slice(0, 2) || "?"}
                  </span>
                )}
                <div className={styles.choiceAction}>
                  <Button
                    variant="primary"
                    disabled={disabled}
                    onClick={() => {
                      setMovingAvatar(selected?.id);
                      setView("collections");
                    }}
                  >
                    Choose avatar
                  </Button>
                </div>
              </motion.div>
            ) : view === "collections" ? (
              <div className={styles.collections}>
                {representatives.map((pack) => (
                  <SurfaceButton
                    className={styles.collection}
                    key={pack.id}
                    disabled={disabled}
                    onClick={() => {
                      setMovingAvatar(
                        selected?.collectionId === pack.id
                          ? selected.id
                          : pack.avatar?.id,
                      );
                      setView(pack.id);
                    }}
                  >
                    {selected?.collectionId === pack.id
                      ? artwork(selected)
                      : pack.avatar && artwork(pack.avatar)}
                    <span>{pack.label}</span>
                  </SurfaceButton>
                ))}
                <SurfaceButton
                  className={styles.collection}
                  disabled={disabled}
                  onClick={() => setView("image")}
                >
                  <span
                    className={`${styles.artwork} ${styles.uploadIcon}`}
                    aria-hidden="true"
                  >
                    <CloudUploadIcon size={48} />
                  </span>
                  <span>Use image</span>
                </SurfaceButton>
              </div>
            ) : view === "image" ? (
              <div className={styles.imageEditor}>
                <AvatarEditor
                  triggerStyle="dotted-squircle"
                  inlinePicker
                  imageOnly
                  actionTarget={avatarActionTarget}
                  shape="squircle"
                  value={selected ? "" : (picture ?? "")}
                  name={name}
                  community={community}
                  disabled={disabled}
                  onBusyChange={onBusyChange}
                  onChange={(value) => {
                    // Done with no image keeps the avatar it had.
                    if (value) onChange({ picture: value });
                    setView("selected");
                  }}
                />
              </div>
            ) : (
              <fieldset
                ref={options}
                className={styles.options}
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${Math.max(1, Math.ceil(choices.length / columns))}, minmax(0, 1fr))`,
                }}
                disabled={disabled}
                aria-label={avatarPacks.find((pack) => pack.id === view)?.label}
              >
                {choices.map((avatar) => (
                  <SurfaceButton
                    key={avatar.id}
                    className={styles.option}
                    aria-label={avatar.label}
                    aria-pressed={picture === avatar.url}
                    onClick={() => {
                      setMovingAvatar(avatar.id);
                      onChange({ picture: avatar.url });
                      setView("selected");
                    }}
                  >
                    {artwork(avatar)}
                  </SurfaceButton>
                ))}
              </fieldset>
            )}
          </motion.div>
        </div>
        <motion.div
          className={styles.title}
          initial={false}
          animate={{
            opacity: view === "selected" && !(editing && !name.trim()) ? 1 : 0,
            scale: editing
              ? 0.65
              : view === "selected" || reducedMotion || keyboard
                ? 1
                : 0.96,
            y: editing ? 176 - (gridSize.height + 32) / 2 - 44 : 0,
          }}
          transition={transition}
          inert={view !== "selected" || (editing && !name.trim())}
          aria-hidden={view !== "selected" || (editing && !name.trim())}
        >
          <Field label="Name" labelVisibility="hidden">
            <Input
              ref={nameRef}
              appearance="title"
              disabled={disabled}
              placeholder="Agent name"
              value={name}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </Field>
        </motion.div>
        <div className={styles.details} hidden={view !== "selected"}>
          {details}
        </div>
      </fieldset>
    </LayoutGroup>
  );
}
