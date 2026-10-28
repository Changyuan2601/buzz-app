import { useLayoutEffect, useRef } from "react";
import styles from "./ChannelTabs.module.css";

// Moving a DOM node between panes resets descendant scroll offsets. Remember
// them while detached and restore after the node is attached again.
const offsets = new WeakMap<HTMLElement, number[]>();
const scrollers = (node: HTMLElement) => [
  ...node.querySelectorAll<HTMLElement>("[data-message-scroller]"),
];

/** Attaches a tab's retained content node; the content itself never remounts. */
export function TabSlot({ node }: { node: HTMLElement }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const parent = slot.current;
    if (!parent) return;
    // The source dock can still retain its old slot during exit. Capture
    // the live reading position before reparenting resets descendant offsets.
    const restore = node.isConnected
      ? scrollers(node).map((element) => element.scrollTop)
      : offsets.get(node);
    parent.append(node);
    if (restore)
      scrollers(node).forEach((element, index) => {
        element.scrollTop = restore[index] ?? element.scrollTop;
      });
    return () => {
      // The closing dock can retire its old slot after the destination has
      // claimed this node. Only its current parent may detach or save it.
      if (node.parentElement !== parent) return;
      offsets.set(
        node,
        scrollers(node).map((element) => element.scrollTop),
      );
      node.remove();
    };
  }, [node]);
  return <div ref={slot} data-tab-slot="" className={styles.tabSlot} />;
}

/**
 * Detaches a closing tab's content, keeping its offsets, when it can wait
 * detached and later reattach exactly as a fresh opening shows it: read to
 * its end, collapsed, with no media playing. Returns whether it can.
 */
export function retain(node: HTMLElement) {
  const elements = node.isConnected ? scrollers(node) : [];
  const retainable =
    node.isConnected &&
    elements.every(
      (element) =>
        element.scrollHeight - element.scrollTop - element.clientHeight <= 2,
    ) &&
    !node.querySelector('[aria-expanded="true"]') &&
    [...node.querySelectorAll<HTMLMediaElement>("video, audio")].every(
      (media) => media.paused,
    );
  if (retainable) {
    offsets.set(
      node,
      elements.map((element) => element.scrollTop),
    );
    // Detach now, as unmounting would empty it: a closing dock keeps its
    // slot through its exit, and must not restyle retained content there.
    node.remove();
  }
  return retainable;
}

/** One detached container per open or retained tab id, retired otherwise. */
export function useTabNodes(ids: readonly string[]) {
  const nodes = useRef(new Map<string, HTMLDivElement>());
  for (const id of ids)
    if (!nodes.current.has(id)) {
      const node = document.createElement("div");
      node.dataset.tabHost = "";
      node.className = styles.tabSlot ?? "";
      nodes.current.set(id, node);
    }
  const live = new Set(ids);
  for (const [id, node] of nodes.current)
    if (!live.has(id)) {
      node.remove();
      nodes.current.delete(id);
    }
  return nodes.current;
}
