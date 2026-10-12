import { useState } from "react";
import { CollectionCard } from "../../../../src/shared/design-system/ui/CollectionCard";
import { Avatar } from "../../../../src/shared/design-system/ui/Avatar";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import { PlusIcon } from "../../../../src/shared/design-system/icons";

export function CollectionCardSpecimens() {
  const [added, setAdded] = useState(false);
  const [selected, setSelected] = useState("first");
  return (
    <div className="grid gap-6">
      <p className="text-body text-secondary">
        Use cards when artwork helps identify objects. Keep the main action
        visible; secondary actions reveal on hover or keyboard focus and stay
        visible on touch. Selection and keyboard navigation belong to the
        surrounding collection.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <CollectionCard
          artwork={<Avatar alt="" fallback="Example" size="fill" />}
          title={
            <Button variant="link" onClick={() => setAdded(!added)}>
              Example item
            </Button>
          }
          description={
            added
              ? "Added in this example"
              : "Hover or Tab to reveal the action"
          }
          action={
            <IconButton
              aria-label="Add example item"
              size="sm"
              disabled={added}
              variant="prominent"
              shape="round"
              icon={<PlusIcon size={16} />}
              onClick={() => setAdded(true)}
            />
          }
        />
        <CollectionCard>
          <p className="text-label">Start something new</p>
          <Button variant="prominent" onClick={() => setAdded(false)}>
            Create item
          </Button>
        </CollectionCard>
      </div>
      <div
        role="listbox"
        aria-label="Selection example"
        className="grid gap-4 sm:grid-cols-2"
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const next = selected === "first" ? "second" : "first";
          setSelected(next);
          event.currentTarget
            .querySelectorAll<HTMLElement>('[role="option"]')
            [next === "first" ? 0 : 1]?.focus();
        }}
      >
        {["first", "second"].map((id) => (
          <CollectionCard
            key={id}
            role="option"
            selected={id === selected}
            tabIndex={id === selected ? 0 : -1}
            onClick={() => setSelected(id)}
            title={id === "first" ? "First item" : "Second item"}
            description="Select, then use the arrow keys."
          />
        ))}
      </div>
      <p className="text-body-sm text-secondary">
        Creation composition: the same frame with a visible Button and optional
        decorative artwork. The product owns the illustration and creation flow.
      </p>
    </div>
  );
}
