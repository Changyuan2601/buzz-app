import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import { CircleNotchIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { ProviderDialog } from "./ProviderDialog";

export function AgentDefaults({ agents }: { agents: Agents }) {
  const types = useSyncExternalStore(
    agents.subscribe,
    agents.types,
    agents.types,
  );
  useEffect(() => {
    for (const { provider } of types) {
      if (!provider) continue;
      try {
        void Promise.resolve(provider.check()).catch(() => {});
      } catch {
        // A failed contribution must not block the other providers.
      }
    }
  }, [types]);
  return (
    <div className="mt-section-gap">
      <InlineHeader title="AI defaults" />
      <SettingsGroup>
        {types.map((type) => {
          const fallback = (
            <PreferenceRow
              title={type.title}
              trailing={
                <Button
                  size="sm"
                  disabled
                  aria-label={`${type.title}, unavailable`}
                >
                  Unavailable
                </Button>
              }
            />
          );
          return (
            <ContributionBoundary
              key={contributionKey(type)}
              fallback={fallback}
            >
              {type.provider ? (
                <ProviderDefaults type={type} provider={type.provider} />
              ) : (
                fallback
              )}
            </ContributionBoundary>
          );
        })}
      </SettingsGroup>
    </div>
  );
}

function ProviderDefaults({
  type,
  provider,
}: {
  type: RegisteredAgentType;
  provider: NonNullable<RegisteredAgentType["provider"]>;
}) {
  const state = useSyncExternalStore(
    provider.subscribe,
    provider.snapshot,
    provider.snapshot,
  );
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const checking = state.readiness === "checking";
  const label =
    state.readiness === "attention"
      ? (state.attentionLabel ?? `Set up ${type.title}`)
      : type.title;
  const Icon = type.icon;
  const select = () => {
    if (state.readiness === "attention" && provider.attentionAction) {
      try {
        provider.attentionAction();
        return;
      } catch {
        // Fall back to the provider's recovery guidance.
      }
    }
    setOpen(true);
  };
  return (
    <>
      <PreferenceRow
        title={type.title}
        icon={Icon && <Icon size={20} />}
        trailing={
          <Button
            ref={trigger}
            size="sm"
            aria-label={`${label}, ${state.readiness}`}
            aria-busy={checking || undefined}
            disabled={checking}
            onClick={select}
          >
            {checking && (
              <CircleNotchIcon
                size={17}
                aria-hidden="true"
                className="motion-safe:animate-spin"
              />
            )}
            {checking
              ? "Checking…"
              : state.readiness === "attention"
                ? label
                : "Configure"}
          </Button>
        }
      />
      {open && (
        <ProviderDialog
          type={type}
          finalFocus={trigger}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
