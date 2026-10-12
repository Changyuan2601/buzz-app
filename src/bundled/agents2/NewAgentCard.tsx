import { Button } from "../../shared/design-system/ui/Button";
import { CollectionCard } from "../../shared/design-system/ui/CollectionCard";
import fuzzy from "./artwork/fuzzies-1.webp";
import capybara from "./artwork/fuzzies-18.webp";
import fish from "./artwork/fuzzies-4.webp";
import helmet from "./artwork/gloopies-20.webp";
import tomato from "./artwork/gloopies-3.webp";
import hand from "./artwork/gloopies-2.webp";
import person from "./artwork/pollies-1.webp";
import turtle from "./artwork/pollies-10.webp";
import dog from "./artwork/pollies-24.webp";
import friend from "./artwork/pollies-26.webp";
import styles from "./Agents2Page.module.css";

const artwork = [
  fuzzy,
  capybara,
  fish,
  helmet,
  tomato,
  hand,
  person,
  turtle,
  dog,
  friend,
];

/** Decorative creation artwork. Never assigned to a real agent identity. */
export function NewAgentCard({
  onCreate,
  disabled = false,
}: {
  onCreate(): void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.newAgent} data-disabled={disabled || undefined}>
      <CollectionCard>
        <div className={styles.creationArt} aria-hidden="true">
          {artwork.map((src) => (
            <img key={src} src={src} alt="" draggable={false} />
          ))}
        </div>
        <div className={styles.creationAction}>
          <Button variant="prominent" disabled={disabled} onClick={onCreate}>
            New agent
          </Button>
        </div>
      </CollectionCard>
    </div>
  );
}
