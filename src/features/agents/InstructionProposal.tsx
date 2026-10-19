import {
  createContext,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Agent, Agents } from "./service";
import type { InstructionSuggestion } from "./onboarding";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";

const ProposalContext = createContext<InstructionSuggestion | undefined>(
  undefined,
);
const none = () => undefined;
const noSubscribe = () => () => {};

/** The settings form keeps its config draft and Save; this only offers text. */
export function InstructionProposalProvider({
  agents,
  agent,
  children,
}: {
  agents: Agents;
  agent: Agent;
  children: ReactNode;
}) {
  const proposal = useSyncExternalStore(
    agents.subscribeInstructionProposals ?? noSubscribe,
    agents.instructionProposal
      ? () => agents.instructionProposal(agent.pubkey)
      : none,
    none,
  );
  const saved =
    agent.config &&
    typeof agent.config === "object" &&
    "instructions" in agent.config &&
    typeof agent.config.instructions === "string"
      ? agent.config.instructions
      : "";
  const suggestion =
    proposal && proposal.type === agent.type && proposal.basedOn === saved
      ? {
          ...proposal,
          dismiss: () =>
            agents.dismissInstructionProposal(agent.pubkey, proposal.id),
        }
      : undefined;
  return <ProposalContext value={suggestion}>{children}</ProposalContext>;
}

export function InstructionProposal({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange(text: string): void;
}) {
  const suggestion = useContext(ProposalContext);
  const [confirm, setConfirm] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  if (!suggestion) return null;
  const applied = value === suggestion.text;
  const apply = () => {
    onChange(suggestion.text);
    setConfirm(undefined);
  };
  return (
    <section className="grid gap-3" aria-label="Suggested instructions">
      <p className="m-0 text-body-sm text-subtle">
        Your agent suggested these instructions. Review them here, apply them to
        your draft, then choose Save. Nothing has been saved yet.
      </p>
      <p className="m-0 whitespace-pre-wrap text-body-sm">{suggestion.text}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={trigger}
          disabled={disabled || applied}
          onClick={() =>
            value !== suggestion.basedOn ? setConfirm(suggestion.id) : apply()
          }
        >
          {applied ? "Applied to draft" : "Apply to draft"}
        </Button>
        <Button
          disabled={disabled}
          variant="ghost"
          onClick={suggestion.dismiss}
        >
          Dismiss suggestion
        </Button>
      </div>
      {confirm === suggestion.id && (
        <AlertDialog
          title="Replace the instructions draft?"
          description="Your instructions have changed since this suggestion was made. Applying it replaces the current draft, not the saved agent settings. Review it before saving."
          finalFocus={trigger}
          onClose={() => setConfirm(undefined)}
          actions={
            <>
              <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
              <Button variant="prominent" onClick={apply}>
                Replace draft
              </Button>
            </>
          }
        />
      )}
    </section>
  );
}
