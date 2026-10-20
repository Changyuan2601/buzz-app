import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRelayConnection } from "../features/relay/react";
import type { RelayData } from "../features/relay/service";
import type {
  ArchiveHost,
  ArchiveSettings as Preferences,
} from "../features/archive/types";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { Select } from "../shared/design-system/ui/Select";
import { Button } from "../shared/design-system/ui/Button";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";

export function ArchiveSettings({
  relay,
  community,
  active,
}: {
  relay: RelayData;
  community?: string | undefined;
  active: boolean;
}) {
  const connection = useRelayConnection(relay);
  if (!community)
    return (
      <ArchiveCard>
        <p>Select a community to manage its saved agent activity.</p>
      </ArchiveCard>
    );
  if (connection.status !== "ready")
    return (
      <ArchiveCard community={community}>
        <p>
          {connection.status === "connecting"
            ? `Connecting to ${community}… Archive settings will appear when connected.`
            : `Connect to ${community} to manage its archive.`}
        </p>
      </ArchiveCard>
    );
  const host = connection.session.agentActivity.archive;
  return host ? (
    <ArchiveControls
      key={`${connection.scope}:${connection.generation}`}
      host={host}
      community={community}
      active={active}
      clearActivity={connection.session.agentActivity.clearHistory}
    />
  ) : (
    <ArchiveCard community={community}>
      <p>This host does not support saving agent history.</p>
    </ArchiveCard>
  );
}
function ArchiveCard({
  community,
  children,
}: {
  community?: string | undefined;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section className="mt-section-gap" aria-labelledby={heading}>
      <InlineHeader
        id={heading}
        title={`Saved agent activity${community ? ` · ${community}` : ""}`}
      />
      <SettingsGroup layout="form">{children}</SettingsGroup>
    </section>
  );
}
export function ArchiveControls({
  host,
  community,
  active,
  clearActivity,
}: {
  host: ArchiveHost;
  community: string;
  active: boolean;
  clearActivity: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Preferences>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<24200 | 44200>();
  const [retention, setRetention] = useState<number>();
  const [retry, setRetry] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry retires the old read and reloads the same host.
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    lifetime.current = abort;
    setBusy(false);
    setConfirm(undefined);
    setRetention(undefined);
    setError("");
    setSettings(undefined);
    void host.settings(abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) {
          setSettings(value);
          setError("");
        }
      },
      () => {
        if (!abort.signal.aborted)
          setError(
            "Could not read archive settings. No capture preference was changed.",
          );
      },
    );
    return () => abort.abort();
  }, [host, active, retry]);
  const save = async (patch: Partial<Preferences>) => {
    const signal = lifetime.current?.signal;
    if (!settings || busy || !signal || signal.aborted) return;
    setBusy(true);
    setError("");
    try {
      const saved = await host.configure({ ...settings, ...patch }, signal);
      if (!signal.aborted) setSettings(saved);
    } catch {
      if (!signal.aborted)
        setError("Could not save archive settings. Reload settings and retry.");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <ArchiveCard community={community}>
      <p className="text-body-sm text-secondary">
        {host.location === "device"
          ? "Saved in this app’s local SQLite archive on this device."
          : "Saved in SQLite on the development broker’s machine, not in this browser."}{" "}
        Records are partitioned by account and community. Capture runs while
        this community is connected, even with Agent Activity disabled.
      </p>
      {settings ? (
        <>
          <p className="text-body-sm text-secondary">
            Archive file: <code className="break-all">{settings.path}</code>
            <br />
            This account and community:{" "}
            {(settings.bytes / 1024 / 1024).toFixed(1)} MiB of encrypted
            records. SQLite indexes and temporary journal files use additional
            disk space.
          </p>
          <SwitchPreferenceRow
            label="Save agent activity"
            description="Keep encrypted owner-only activity. Turning this off leaves saved history intact."
            checked={settings.observer}
            disabled={busy}
            onCheckedChange={(observer) => void save({ observer })}
          />
          <SwitchPreferenceRow
            label="Save agent turn metrics"
            description="Keep encrypted token and cost records for 90 days, up to 64 MiB per community (16 MiB per agent). A usage dashboard is not included."
            checked={settings.metrics}
            disabled={busy}
            onCheckedChange={(metrics) => void save({ metrics })}
          />
          <Select
            label="Activity retention"
            value={String(settings.observerDays)}
            disabled={busy}
            groups={[
              {
                label: "Maximum age",
                options: [1, 7, 30, 90].map((days) => ({
                  value: String(days),
                  label: `${days} ${days === 1 ? "day" : "days"}`,
                })),
              },
            ]}
            onValueChange={(value) => {
              const days = Number(value);
              if (days < settings.observerDays) setRetention(days);
              else void save({ observerDays: days });
            }}
          />
          <p className="text-body-sm text-secondary">
            Activity is limited to 512 MiB per community and 128 MiB per agent.
            Oldest records may be removed sooner at the size limit. Shortening
            retention deletes expired records; turning capture off does not
            delete them. Budgets apply separately to each account and community,
            not to the entire device.
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => setConfirm(24200)}
            >
              Clear activity history
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => setConfirm(44200)}
            >
              Clear turn metrics
            </Button>
          </div>
        </>
      ) : (
        !error && <p role="status">Loading archive settings…</p>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => setRetry((value) => value + 1)}
          >
            Reload archive settings
          </Button>
        </>
      )}
      {retention !== undefined && (
        <AlertDialog
          title="Shorten activity retention?"
          description={`Permanently deletes activity older than ${retention} ${retention === 1 ? "day" : "days"} for this account in ${community}. This cannot be undone.`}
          pending={busy}
          onClose={() => setRetention(undefined)}
          actions={
            <>
              <Button disabled={busy} onClick={() => setRetention(undefined)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  await save({ observerDays: retention });
                  setRetention(undefined);
                }}
              >
                Shorten retention
              </Button>
            </>
          }
        />
      )}
      {confirm && (
        <AlertDialog
          title={
            confirm === 24200
              ? "Clear activity history?"
              : "Clear turn metrics?"
          }
          description={`Permanently removes this account’s saved ${confirm === 24200 ? "activity" : "turn metrics"} in ${community}. New records can still be captured.`}
          pending={busy}
          onClose={() => setConfirm(undefined)}
          actions={
            <>
              <Button disabled={busy} onClick={() => setConfirm(undefined)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  const signal = lifetime.current?.signal;
                  if (!signal || signal.aborted || busy) return;
                  setBusy(true);
                  setError("");
                  try {
                    if (confirm === 24200) await clearActivity();
                    else await host.clear(confirm);
                    if (signal.aborted) return;
                    setConfirm(undefined);
                    try {
                      const saved = await host.settings(signal);
                      if (!signal.aborted) setSettings(saved);
                    } catch {
                      if (!signal.aborted)
                        setError(
                          "Records cleared, but archive settings could not be refreshed. Reload settings.",
                        );
                    }
                  } catch {
                    if (!signal.aborted) {
                      setError(
                        "Could not clear the archive. Saved records may remain; retry.",
                      );
                      setConfirm(undefined);
                    }
                  } finally {
                    if (!signal.aborted) setBusy(false);
                  }
                }}
              >
                Clear saved records
              </Button>
            </>
          }
        />
      )}
    </ArchiveCard>
  );
}
