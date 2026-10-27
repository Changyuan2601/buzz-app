import { spring } from "motion";
import styles from "./Messages.module.css";
import { flushSync } from "react-dom";
const running = new WeakMap<HTMLElement, Animation[]>();
function avatars(scope: HTMLElement, group: string) {
  return new Map(
    [...scope.querySelectorAll<HTMLElement>("[data-avatar-motion-key]")]
      .filter(
        (node) =>
          node.dataset.avatarMotionKey?.startsWith(`${group}:`) &&
          !node.closest("[inert]") &&
          node.getBoundingClientRect().height > 0,
      )
      .map((node) => [node.dataset.avatarMotionKey ?? "", node]),
  );
}

/** FLIP only the avatar artwork. No new layout engine or animation dependency. */
export function toggleActivityHistory(
  button: HTMLButtonElement,
  toggle: () => void,
  keyboard: boolean,
  group: string,
) {
  const scope = button.closest<HTMLElement>("[data-activity-history-scope]");
  const view = button.ownerDocument.defaultView;
  if (!scope || !view) return toggle();
  const visibleRows = new Set(
    [...scope.querySelectorAll<HTMLElement>('[data-audience="agents"]')].filter(
      (node) => !node.closest("[inert]"),
    ),
  );
  const before = new Map(
    [...avatars(scope, group)].map(([key, node]) => [
      key,
      node.getBoundingClientRect(),
    ]),
  );
  for (const animation of running.get(scope) ?? []) animation.cancel();
  running.delete(scope);
  delete scope.dataset.activityMatching;
  if (
    keyboard ||
    view.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    typeof button.animate !== "function"
  )
    return toggle();
  scope.dataset.activityMatching = "";
  flushSync(toggle);
  // Match the composer's gentle spring, sampled for native WAAPI playback.
  const duration = 240;
  const curve = spring({ keyframes: [0, 1], duration, bounce: 0.15 });
  const easing = `linear(${Array.from({ length: 31 }, (_, index) =>
    index === 30 ? 1 : curve.next((index * duration) / 30).value,
  ).join(", ")})`;
  const animations: Animation[] = [];
  for (const [key, node] of avatars(scope, group)) {
    const from = before.get(key);
    const to = node.getBoundingClientRect();
    if (!to.width || !to.height) continue;
    if (from && (Math.abs(from.x - to.x) > 1 || Math.abs(from.y - to.y) > 1)) {
      const artwork = node.firstElementChild;
      if (artwork instanceof HTMLElement)
        animations.push(
          artwork.animate(
            [
              { filter: "blur(0px)", transform: "scale(1, 1)" },
              {
                filter: "blur(0.7px)",
                transform: "scale(0.97, 1.03)",
                offset: 0.35,
              },
              { filter: "blur(0px)", transform: "scale(1, 1)" },
            ],
            { duration, easing: "ease-out", fill: "both" },
          ),
        );
    }
    animations.push(
      node.animate(
        from
          ? [
              {
                transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width}, ${from.height / to.height})`,
                transformOrigin: "top left",
              },
              { transform: "none", transformOrigin: "top left" },
            ]
          : [{ opacity: 0 }, { opacity: 1 }],
        { duration, easing, fill: "both" },
      ),
    );
  }
  for (const row of scope.querySelectorAll<HTMLElement>(
    '[data-audience="agents"]',
  )) {
    if (visibleRows.has(row) || row.closest("[inert]")) continue;
    const text = row.querySelector<HTMLElement>(
      `.${styles.audiencePreviewText}`,
    );
    if (text)
      animations.push(
        text.animate(
          [
            { transform: "translateY(4px)", opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
          { duration, easing, fill: "both" },
        ),
      );
  }
  running.set(scope, animations);
  void Promise.all(
    animations.map((animation) => animation.finished.catch(() => {})),
  ).then(() => {
    if (running.get(scope) !== animations) return;
    for (const animation of animations) animation.cancel();
    running.delete(scope);
    delete scope.dataset.activityMatching;
  });
}
