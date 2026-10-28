// Share: the agent's catalog listing in its community, and a file export.
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import {
  catalogContent,
  catalogHead,
  isShared,
  publishShare,
  shareable,
  snapshotJson,
  snapshotPng,
} from "../../features/agents/agent-share";
import type { Agent, RegisteredAgentType } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import { downloadNativeFile } from "../../features/messages/native-download";
import type { RelaySession } from "../../features/relay/session";
import { avatarSource } from "../../shared/avatar-source";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const FORMATS = [
  { value: "png", label: "PNG" },
  { value: "json", label: "JSON" },
];

/** How long export waits for the picture, which keeps the dialog open. */
const ARTWORK_MS = 5000;

/** The picture redrawn as a 512×512 PNG, as earlier Buzz exported it. Missing,
 * unreadable or slow artwork leaves the snapshot without it. */
async function artwork(picture: string | undefined, session: RelaySession) {
  const source = avatarSource(picture);
  const src = source?.startsWith("data:")
    ? source
    : source && session.media(source);
  if (!src) return undefined;
  const image = new Image();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    image.crossOrigin = "anonymous";
    image.src = src;
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => {
        timer = setTimeout(reject, ARTWORK_MS);
      }),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    canvas.getContext("2d")?.drawImage(image, 0, 0, 512, 512);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  } catch {
    // Stops a load still in flight.
    image.src = "";
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A plain, bounded file name on every desktop, where Windows reserves device
 * names such as `CON` whatever the extension. */
function fileName(name: string, format: string) {
  const stem = name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64);
  const plain = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
    ? `${stem}-agent`
    : stem;
  return `${plain}.agent.${format}`;
}

/** Desktop saves natively and says where; a browser downloads the file to
 * wherever its settings say. */
async function save(file: Blob, name: string): Promise<string | undefined> {
  if (isTauri()) return downloadNativeFile(file, name);
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // WebKit may still be reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AgentShareDialog({
  agent,
  type,
  session,
  onClose,
}: {
  agent: Agent;
  type: RegisteredAgentType | undefined;
  session: RelaySession;
  onClose(): void;
}) {
  // `null` while the catalog is read; `undefined` once read with no head.
  const [head, setHead] = useState<EventData | undefined | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [format, setFormat] = useState<"png" | "json">("png");
  // The read failed; clearing it reads again.
  const [unread, setUnread] = useState(false);
  const attempt = useRef<AbortController>(null);
  useEffect(() => {
    if (unread) return;
    const controller = new AbortController();
    attempt.current = controller;
    catalogHead(session, agent.owner, agent.pubkey, controller.signal).then(
      setHead,
      () => !controller.signal.aborted && setUnread(true),
    );
    return () => controller.abort();
  }, [session, agent.owner, agent.pubkey, unread]);
  const share = async (shared: boolean) => {
    const signal = attempt.current?.signal;
    if (head === null || pending || !signal) return;
    setPending(true);
    setNotice("");
    setError("");
    let failure = "Try again.";
    try {
      // Unsharing keeps what was shared, so it never depends on the agent
      // still being shareable.
      const content =
        !shared && head ? head.content : catalogContent(shareable(agent, type));
      await publishShare(session, agent.pubkey, content, shared, head, signal);
    } catch (reason) {
      failure = message(reason);
    }
    // An accepted publish can still lose to a newer head, and an unanswered
    // one may still have landed, so the relay says which head won. Until it
    // answers, the last head it confirmed stands.
    const next = await catalogHead(
      session,
      agent.owner,
      agent.pubkey,
      signal,
    ).catch(() => head);
    if (signal.aborted) return;
    setHead(next);
    if (isShared(next) === shared)
      setNotice(
        shared
          ? `Published ${agent.name} to the community catalog.`
          : `${agent.name} is no longer discoverable in the community catalog.`,
      );
    else setError(`Failed to update catalog sharing. ${failure}`);
    setPending(false);
  };
  // A share is a copy: edits reach the catalog only when it is updated. What
  // can't be shared any more says why on Update share.
  let current: string | undefined;
  try {
    current = catalogContent(shareable(agent, type));
  } catch {}
  const stale = !!head && isShared(head) && current !== head.content;
  const exportAgent = async () => {
    if (pending) return;
    setPending(true);
    setNotice("");
    setError("");
    try {
      const definition = shareable(agent, type);
      const file =
        format === "png"
          ? snapshotPng(definition, await artwork(agent.picture, session))
          : new Blob([snapshotJson(definition)], { type: "application/json" });
      const path = await save(file, fileName(agent.name, format));
      setNotice(
        path ? `Exported ${agent.name} to ${path}.` : `Exported ${agent.name}.`,
      );
    } catch (reason) {
      setError(`Failed to export agent snapshot. ${message(reason)}`);
    }
    setPending(false);
  };
  return (
    <Dialog
      open
      size="compact"
      title={`Share ${agent.name}`}
      description="Anyone you share this agent with will receive a copy they can add and use. Changes you make later won’t sync."
      preventClose={pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Close
          </Button>
          <Button disabled={pending} onClick={() => void exportAgent()}>
            Export agent
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <SettingsGroup>
          <SwitchPreferenceRow
            label="Share to catalog"
            description="Anyone in this community can find and use a copy. Your agent instruction is shared as plaintext. Memories and secrets aren’t included."
            checked={isShared(head ?? undefined)}
            disabled={head === null || pending}
            onCheckedChange={(shared) => void share(shared)}
          />
          <Select
            label="File format"
            variant="preference"
            value={format}
            disabled={pending}
            groups={[{ label: "", options: FORMATS }]}
            onValueChange={(value) => setFormat(value as "png" | "json")}
          />
        </SettingsGroup>
        {stale && (
          <div className="flex flex-col items-start gap-2">
            <p className="m-0 text-body-sm text-secondary">
              The shared copy is older than this agent.
            </p>
            <Button disabled={pending} onClick={() => void share(true)}>
              Update share
            </Button>
          </div>
        )}
        {notice && (
          <p
            role="status"
            className="m-0 text-body-sm text-secondary wrap-anywhere"
          >
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
        {unread && (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="m-0 text-body-sm text-danger">
              Could not read the community catalog. Check the community
              connection, then retry.
            </p>
            <Button onClick={() => setUnread(false)}>Try again</Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
