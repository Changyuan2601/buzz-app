import {
  DndContext,
  DragOverlay,
  PointerSensor,
  type CollisionDetection,
  pointerWithin,
  useDraggable,
  useDndMonitor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SidebarSection } from "../../bundled/channels/SidebarSection";

const Writable = createContext(false);

// Group gaps target the neighbour whose insertion edge lies in that same gap.
const sidebarCollisions: CollisionDetection = (args) => {
  if (!args.active.data.current?.group) return pointerWithin(args);
  const groups = args.droppableContainers
    .filter(({ id }) => String(id).startsWith("group:"))
    .sort((a, b) => a.data.current?.groupIndex - b.data.current?.groupIndex);
  const hits = pointerWithin({ ...args, droppableContainers: groups });
  if (hits.length) return hits;
  const pointer = args.pointerCoordinates;
  if (!pointer) return [];
  for (let index = 1; index < groups.length; index++) {
    const above = groups[index - 1];
    const below = groups[index];
    if (!above || !below) continue;
    const top = args.droppableRects.get(above.id);
    const bottom = args.droppableRects.get(below.id);
    if (
      top &&
      bottom &&
      pointer.y > top.bottom &&
      pointer.y < bottom.top &&
      pointer.x >= Math.max(top.left, bottom.left) &&
      pointer.x <= Math.min(top.right, bottom.right)
    ) {
      const target =
        args.active.data.current.groupIndex < below.data.current?.groupIndex
          ? above
          : below;
      return [{ id: target.id }];
    }
  }
  return [];
};

/**
 * Pointer moves between sidebar sections (Messages groups, Starred and Channels,
 * or Solo projects and Chats), and reorders saved groups by their header. A drop
 * only reports its destination, so the caller saves it exactly like the menus'
 * moves; those menus remain the keyboard path.
 */
export function ChannelSidebarDnd({
  writable,
  onMove,
  onReorder,
  overlay,
  children,
}: {
  writable: boolean;
  onMove: (channelId: string, sectionKey: string) => void;
  onReorder: (sectionKey: string, overKey: string) => void;
  overlay: (id: string, group: boolean) => ReactNode;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<{ id: string; group: boolean }>();
  const sensors = useSensors(
    // A click must still select the row; only a deliberate pull starts a move.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarCollisions}
      // The sidebar's own status is its loading notice; drag announcements live outside it.
      accessibility={{ container: document.body }}
      onDragStart={({ active }) =>
        setDragging({
          id: String(active.id),
          group: !!active.data.current?.group,
        })
      }
      onDragCancel={() => setDragging(undefined)}
      onDragEnd={({ active, over }) => {
        setDragging(undefined);
        if (!over) return;
        if (active.data.current?.group) {
          if (over.id !== active.id)
            onReorder(String(active.id), String(over.id));
        } else if (over.id !== active.data.current?.sectionKey)
          onMove(String(active.id), String(over.id));
      }}
    >
      <Writable.Provider value={writable}>{children}</Writable.Provider>
      {createPortal(
        // The optimistic move relocates the row, so nothing remains to settle back onto.
        <DragOverlay dropAnimation={null}>
          {dragging ? overlay(dragging.id, dragging.group) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/**
 * Frames only a channel's select surface, so its sessions never start a move.
 * The frame stays mounted while placement is read-only: the row keeps its
 * focus and open menu when a save starts or settles.
 */
export function DraggableChannel({
  channelId,
  sectionKey,
  children,
}: {
  channelId: string;
  sectionKey: string;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: channelId,
    data: { sectionKey },
    disabled: !useContext(Writable),
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      data-channel-dragging={isDragging || undefined}
    >
      {children}
    </div>
  );
}

/** A reorderable saved group drags by its header, never its rows or actions. */
export function DroppableSidebarSection({
  disabled,
  reorderable,
  groupIndex,
  ...section
}: ComponentProps<typeof SidebarSection> & {
  disabled: boolean;
  reorderable: boolean;
  groupIndex: number;
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: section.sectionKey,
    data: { groupIndex },
    disabled,
    // dnd-kit queues a re-measure of only the droppable that resized and clears
    // that queue after each render, losing ids queued in between: a section
    // resized mid-drag (text size) could keep a stale drop target. An empty list
    // keeps dnd-kit's drag-start queue: any section's resize re-measures every
    // enabled droppable.
    resizeObserverConfig: { updateMeasurementsFor: [] },
  });
  const drag = useDraggable({
    id: section.sectionKey,
    data: { group: true, groupIndex },
    disabled: !reorderable,
  });
  const suppressClick = useRef(false);
  const handle = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!reorderable) return;
    const document = handle.current?.ownerDocument;
    if (!document) return;
    const suppressDragClick = (event: MouseEvent) => {
      if (
        !suppressClick.current ||
        event.detail === 0 ||
        !(event.target instanceof Node) ||
        !handle.current?.contains(event.target)
      )
        return;
      // dnd-kit stops clicks at document capture before React can cancel the
      // native summary toggle. Cancel there too, including its cleanup window.
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", suppressDragClick, true);
    return () => document.removeEventListener("click", suppressDragClick, true);
  }, [reorderable]);
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (active.id === section.sectionKey) suppressClick.current = true;
    },
  });
  const group = !!active?.data.current?.group;
  const from = active?.data.current?.groupIndex;
  return (
    <SidebarSection
      {...section}
      dropRef={setNodeRef}
      dropTarget={
        !group &&
        isOver &&
        active?.data.current?.sectionKey !== section.sectionKey
      }
      dropEdge={
        group && isOver && active?.id !== section.sectionKey
          ? from !== undefined && from < groupIndex
            ? "after"
            : "before"
          : undefined
      }
      dragHandle={
        reorderable
          ? {
              ref: (node) => {
                handle.current = node;
                drag.setNodeRef(node);
              },
              listeners: {
                ...drag.listeners,
                onPointerDown: (event) => {
                  suppressClick.current = false;
                  drag.listeners?.onPointerDown?.(event);
                },
              },
            }
          : undefined
      }
      dragging={drag.isDragging}
    />
  );
}
