import type { AgentControl } from "../../features/agents/control";
import { useState } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useRelayConnection } from "../../features/relay/react";
import type { SaveTemplateProps } from "../../features/channel-templates/provider";
import type { Template } from "../../features/channel-templates/model";
import { MenuItem, MenuNote } from "../../shared/design-system/ui/Menu";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { TemplateLibrary } from "./TemplateLibrary";
import { ChannelTemplatesDialog } from "./ChannelTemplatesDialog";
import { useTemplateCatalog } from "./useTemplateCatalog";

export function TemplateSettings({
  relay,
  active,
}: {
  relay: RelayData;
  active(): boolean;
}) {
  const connection = useRelayConnection(relay);
  return (
    <section data-buzz-ui="" aria-label="Templates settings">
      {connection.status === "ready" ? (
        <Library
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          active={active}
        />
      ) : (
        <>
          <Header title="Templates" />
          <p role="status">Choose a connected community to manage templates.</p>
        </>
      )}
    </section>
  );
}
function Library({
  session,
  active,
}: {
  session: RelaySession;
  active(): boolean;
}) {
  const catalog = useTemplateCatalog(session);
  return (
    <TemplateLibrary
      session={session}
      kit={session.channelKit}
      catalog={catalog}
      active={active}
    />
  );
}

export function AgentTeams({
  session,
  active,
  control,
}: {
  session: RelaySession;
  control?: AgentControl | undefined;
  active(): boolean;
}) {
  const catalog = useTemplateCatalog(session);
  return (
    <TemplateLibrary
      section="team"
      control={control}
      session={session}
      kit={session.channelKit}
      catalog={catalog}
      active={active}
    />
  );
}

export function SaveAsTemplate({
  session,
  channel,
  active,
  menu,
}: SaveTemplateProps) {
  const catalog = useTemplateCatalog(session);
  const [draft, setDraft] = useState<Template>();
  const [copyWarning, setCopyWarning] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    if (!active()) return;
    setBusy(true);
    setError("");
    try {
      const canvas = await session.canvas.read(channel.id, { strong: false });
      if (!active()) return;
      setCopyWarning(
        catalog.agentsComplete
          ? undefined
          : "Incomplete agent inventory: this copy includes only currently known agents and may omit others in the channel. Review the lineup before saving; reload agents and copy again for a complete snapshot.",
      );
      menu?.close();
      setDraft({
        type: "template",
        id: crypto.randomUUID(),
        name: channel.name,
        description: "",
        teamIds: [],
        agents: catalog.agents
          .filter((a) => channel.members?.includes(a.pubkey))
          .map((a) => a.pubkey),
        canvas: canvas?.content ?? "",
      });
    } catch (error) {
      if (active()) setError(String(error));
    } finally {
      if (active()) setBusy(false);
    }
  };
  const disabled =
    busy || !session.channelKit.available || !catalog.agentsReady;
  return (
    <>
      {menu ? (
        menu.render(
          <>
            <MenuItem disabled={disabled} onClick={copy} closeOnClick={false}>
              Save as template…
            </MenuItem>
            {error && <MenuNote role="alert">{error}</MenuNote>}
          </>,
        )
      ) : (
        <>
          <Button disabled={disabled} onClick={copy}>
            Save as template…
          </Button>
          {error && <p role="alert">{error}</p>}
        </>
      )}
      {draft && (
        <ChannelTemplatesDialog
          session={session}
          open
          onOpenChange={(open) => {
            if (!open) setDraft(undefined);
          }}
          kit={session.channelKit}
          agents={catalog.agents}
          initial={draft}
          finalFocus={menu?.finalFocus}
          notice={copyWarning}
          active={active}
        />
      )}
    </>
  );
}
