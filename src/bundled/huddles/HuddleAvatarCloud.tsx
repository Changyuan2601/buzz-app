import { HuddleAvatarMotion } from "./HuddleAvatarMotion";
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import type { HuddleView } from "../../features/huddle/window";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import styles from "./Huddles.module.css";

// Original mobile cloud. Hover reserves room only around the active name.
const slots = [
  [130, 120, 100],
  [226.2, 203.3, 88],
  [157.2, 228.5, 64],
  [255.3, 135.2, 64],
  [223.8, 108.8, 40],
  [103.2, 236, 48],
  [45.8, 48.7, 88],
  [138.8, 47.5, 64],
  [40.7, 140.8, 64],
  [96.2, 191.2, 40],
] as const;
const overflowSlot = [208.8, 56, 48] as const;
type Slot = readonly [number, number, number];
type ActiveName = { key: string; x: number; y: number };

function arrange(
  slots: readonly Slot[],
  width: number,
  height: number,
  rem: number,
  labelHeight: number,
  activeIndex: number,
  hasSelf: boolean,
  anchor?: ActiveName,
) {
  const scale = Math.min(width / 360, height / 340);
  const meanX =
    slots.reduce((sum, [x, , size]) => sum + x + size / 2, 0) /
    (slots.length || 1);
  const meanY =
    slots.reduce((sum, [, y, size]) => sum + y + size / 2, 0) /
    (slots.length || 1);
  const points = slots.map(([x, y, size]) => ({
    x: (x + size / 2 - meanX) * scale,
    y: (y + size / 2 - meanY) * scale,
    r: (size * scale) / 2,
  }));
  // Center the resting bounds of the whole group, including your portrait.
  // Keep this offset independent of hover and speech so those never move the group.
  const stageWidth = width / 0.64;
  const peerCenter = stageWidth * (hasSelf ? 0.68 : 0.5);
  const portraits = points.map((point) => ({
    ...point,
    x: point.x + peerCenter,
  }));
  if (hasSelf)
    portraits.push({
      x: stageWidth * 0.17,
      y: 0,
      r: Math.max(48, Math.min(stageWidth * 0.2, height * 0.55, 100)) / 2,
    });
  const offset = portraits.length
    ? ({
        "--cloud-shift-x": `${stageWidth / 2 - (Math.min(...portraits.map((p) => p.x - p.r)) + Math.max(...portraits.map((p) => p.x + p.r))) / 2}px`,
        "--cloud-shift-y": `${-(Math.min(...portraits.map((p) => p.y - p.r)) + Math.max(...portraits.map((p) => p.y + p.r))) / 2}px`,
      } as CSSProperties)
    : {};
  const active = points[activeIndex];
  if (active && anchor) {
    // Keep the hovered portrait under the pointer, including during a transition.
    active.x = anchor.x;
    active.y = anchor.y;
    const gap = rem / 2;
    const halfWidth = Math.max(active.r * 2, rem * 3.5) / 2;
    const label = {
      left: active.x - halfWidth,
      right: active.x + halfWidth,
      top: active.y + active.r - labelHeight / 2,
      bottom: active.y + active.r + labelHeight / 2,
    };
    // Resolve only local collisions. Each portrait gets its own displacement;
    // unblocked portraits keep their original position.
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = 0; i < points.length; i++) {
        const point = points[i];
        if (!point || i === activeIndex) continue;
        const closestX = Math.max(label.left, Math.min(label.right, point.x));
        const closestY = Math.max(label.top, Math.min(label.bottom, point.y));
        let dx = point.x - closestX,
          dy = point.y - closestY;
        const distance = Math.hypot(dx, dy);
        if (distance < point.r + gap) {
          if (distance === 0) {
            dx = point.x - active.x;
            dy = point.y - (active.y + active.r);
            if (dx === 0 && dy === 0) dy = 1;
          }
          const length = Math.hypot(dx, dy) || 1;
          const push = point.r + gap - distance;
          point.x += (dx / length) * push;
          point.y += (dy / length) * push;
          moved = true;
        }
      }
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        if (!a) continue;
        for (let j = i + 1; j < points.length; j++) {
          const b = points[j];
          if (!b) continue;
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const distance = Math.hypot(dx, dy);
          const overlap = a.r + b.r + 2 - distance;
          if (overlap <= 0.1) continue;
          const push =
            overlap / (i === activeIndex || j === activeIndex ? 1 : 2);
          const x = (dx / (distance || 1)) * push,
            y = (dy / (distance || 1)) * push;
          if (i !== activeIndex) {
            a.x -= x;
            a.y -= y;
          }
          if (j !== activeIndex) {
            b.x += x;
            b.y += y;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  return {
    offset,
    positions: points.map(
      (point) =>
        ({
          "--bubble-x": `${point.x}px`,
          "--bubble-y": `${point.y}px`,
          width: `${point.r * 2}px`,
        }) as CSSProperties,
    ),
  };
}
type Person = HuddleView["participants"][number];

export function HuddleAvatarCloud({
  participants,
  muted,
}: Pick<HuddleView, "participants" | "muted">) {
  const [active, setActive] = useState<ActiveName>();
  const activeKey = active?.key;
  const self = participants.find((person) => person.own);
  const peers = participants.filter((person) => !person.own);
  const hasPeers = peers.length > 0;
  const visible = peers.slice(0, slots.length);
  const hidden = peers.length - visible.length;
  const occupied = [
    ...slots.slice(0, visible.length),
    ...(hidden ? [overflowSlot] : []),
  ];
  const cloud = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({
    width: 300,
    height: 340,
    rem: 16,
    labelHeight: 20,
  });
  useLayoutEffect(() => {
    if (!hasPeers) return;
    const element = cloud.current;
    if (!element) return;
    const measure = () => {
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
        rem: Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ),
        labelHeight:
          element.querySelector<HTMLElement>("[data-name]")?.offsetHeight ?? 20,
      };
      setBounds((previous) =>
        Object.keys(next).every(
          (key) =>
            previous[key as keyof typeof next] ===
            next[key as keyof typeof next],
        )
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const name = element.querySelector("[data-name]");
    if (name) observer.observe(name);
    return () => observer.disconnect();
  }, [hasPeers]);
  const { positions, offset } = arrange(
    occupied,
    bounds.width,
    bounds.height,
    bounds.rem,
    bounds.labelHeight,
    visible.findIndex((person) => person.key === activeKey),
    !!self,
    active,
  );
  const revealName = (key: string, element: HTMLDivElement) => {
    if (activeKey === key) return;
    const portrait = element.getBoundingClientRect();
    const area = cloud.current?.getBoundingClientRect();
    setActive({
      key,
      x: portrait.x + portrait.width / 2 - (area ? area.x + area.width / 2 : 0),
      y:
        portrait.y +
        portrait.height / 2 -
        (area ? area.y + area.height / 2 : 0),
    });
  };
  const nameInteraction = (key: string): HTMLAttributes<HTMLDivElement> => ({
    tabIndex: 0,
    onPointerEnter: (event) => {
      if (event.pointerType !== "touch") revealName(key, event.currentTarget);
    },
    onPointerLeave: (event) => {
      if (!event.currentTarget.matches(":focus-within"))
        setActive((current) => (current?.key === key ? undefined : current));
    },
    onFocus: (event) => revealName(key, event.currentTarget),
    onBlur: () =>
      setActive((current) => (current?.key === key ? undefined : current)),
    onKeyDown: (event) => {
      if (event.key === "Escape") {
        setActive(undefined);
        event.currentTarget.blur();
      }
    },
  });
  return (
    <section
      className={styles.avatarStage}
      aria-label="Huddle participants"
      data-has-peers={hasPeers}
      style={hasPeers ? offset : undefined}
    >
      {self && (
        <div className={styles.selfBubble} aria-hidden="true">
          <SpeakingHalo level={muted ? 0 : self.level} peer={self.key} />
        </div>
      )}
      {self && (
        <div
          className={`${styles.selfBubble} ${styles.avatarForeground}`}
          data-self=""
          key={self.key}
          data-name-active={activeKey === self.key}
          {...nameInteraction(self.key)}
        >
          <Bubble person={self} muted={muted} />
        </div>
      )}
      {hasPeers && (
        <div ref={cloud} className={styles.remoteCloud} data-has-self={!!self}>
          {visible.map((person, index) => (
            <Fragment key={person.key}>
              <div
                className={styles.cloudBubble}
                style={positions[index]}
                aria-hidden="true"
              >
                <SpeakingHalo level={person.level} peer={person.key} />
              </div>
              <div
                className={`${styles.cloudBubble} ${styles.avatarForeground}`}
                style={positions[index]}
                data-participant={person.key}
                data-name-active={activeKey === person.key}
                {...nameInteraction(person.key)}
              >
                <Bubble person={person} muted={false} />
              </div>
            </Fragment>
          ))}
          {hidden > 0 && (
            <div
              className={`${styles.cloudBubble} ${styles.cloudOverflow}`}
              style={positions[visible.length]}
              role="img"
              aria-label={`${hidden} more participants: ${peers
                .slice(slots.length)
                .map((person) => person.name)
                .join(", ")}`}
              title={peers
                .slice(slots.length)
                .map((person) => person.name)
                .join(", ")}
            >
              <span className="text-label text-primary">+{hidden}</span>
            </div>
          )}
        </div>
      )}
      {!participants.length && (
        <p className="text-body text-secondary">Getting your huddle ready</p>
      )}
    </section>
  );
}

function Bubble({ person, muted }: { person: Person; muted: boolean }) {
  const level = muted ? 0 : Math.max(0, Math.min(1, person.level));
  const label = `${person.name}${person.own ? (muted ? " (you, muted)" : " (you)") : ""}${level > 0 ? ", speaking" : ""}`;
  return (
    <span className={styles.bubbleArtwork}>
      <HuddleAvatarMotion participant={person.key}>
        <Avatar
          size="fill"
          src={person.picture}
          fallback={person.name}
          alt={label}
        />
      </HuddleAvatarMotion>
      <NameBadge name={person.name} />
    </span>
  );
}

function NameBadge({ name }: { name: string }) {
  return (
    <span
      className={`${styles.bubbleName} text-caption`}
      aria-hidden="true"
      title={name}
      data-name=""
    >
      {name}
    </span>
  );
}

function SpeakingHalo({ level, peer }: { level: number; peer: string }) {
  return (
    <span
      className={styles.speakingHalo}
      data-speaking={level > 0}
      data-speaker={peer}
      aria-hidden="true"
      style={
        {
          "--speaker-scale": 1.12 + Math.max(0, Math.min(1, level)) * 0.9,
        } as CSSProperties
      }
    />
  );
}
