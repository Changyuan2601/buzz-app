import { useState } from "react";
import type { Agents } from "../features/agents/service";
import { AgentDefaults } from "../bundled/agents/AgentDefaults";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";

import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Button } from "../shared/design-system/ui/Button";
import {
  setRememberAgentsPreference,
  useRememberAgentsPreference,
} from "../features/messages/mention-preferences";

export function AgentSettings({
  agents,
  active = true,
}: {
  agents?: Agents | undefined;
  active?: boolean;
}) {
  const rememberAgents = useRememberAgentsPreference();
  const [mentionError, setMentionError] = useState<string | null>(null);
  const changeRememberAgents = (enabled: boolean) =>
    setMentionError(setRememberAgentsPreference(enabled));
  return (
    <section aria-labelledby="agent-settings-title">
      <Header id="agent-settings-title" title="Agent setup" />
      {agents && active && <AgentDefaults agents={agents} />}
      <div className="mt-section-gap">
        <InlineHeader title="Agent behavior" />
        <SettingsGroup>
          <SwitchPreferenceRow
            label="Remember mentioned agents"
            description="Keep the same agents selected for your next message in this channel or thread."
            checked={rememberAgents}
            onCheckedChange={changeRememberAgents}
          />
        </SettingsGroup>
      </div>
      {active && mentionError && (
        <ToastNotice
          title="Agent preference wasn’t saved"
          description={mentionError}
        >
          <Button
            type="button"
            size="sm"
            onClick={() => changeRememberAgents(rememberAgents)}
          >
            Retry saving mentioned agents
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}
