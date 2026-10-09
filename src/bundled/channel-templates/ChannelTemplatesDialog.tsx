import { sameCommunityAgents } from "../../features/agents/choices";
import type { AgentControl } from "../../features/agents/control";
import type { TeamSnapshot } from "../../features/agents/team-bundles";
import { relayOrigin } from "../../features/communities/destination";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { RelaySession } from "../../features/relay/session";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type {
  AgentChoice,
  Team,
  Template,
} from "../../features/channel-templates/model";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { PlusIcon } from "../../shared/design-system/icons";
import type { TeamPublication } from "../../features/agents/catalog-protocol";
import {
  unsupportedTransport,
  unsupportedTransportMessage,
} from "../../features/agents/catalog-protocol";
import {
  TeamCatalogPreview,
  catalogAlreadyAdded,
  rememberAdded,
} from "../agents/CommunityCatalog";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { AgentSelection, TemplateFields } from "./TemplateFields";
import styles from "../channels/ChannelTemplates.module.css";

export function ChannelTemplatesDialog({
  session,
  control,
  open,
  onOpenChange,
  kit,
  agents,
  initial,
  expected,
  notice,
  active,
  finalFocus,
  onImport,
  catalogSession,
  onAddCatalogTeam,
}: {
  session?: RelaySession | undefined;
  control?: AgentControl | undefined;
  finalFocus?: DialogProps["finalFocus"];
  onImport?: (() => void) | undefined;
  catalogSession?: RelaySession | undefined;
  onAddCatalogTeam?: ((team: TeamPublication) => Promise<string>) | undefined;
  active(): boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  kit: ChannelKit;
  agents: readonly AgentChoice[];
  initial: Team | Template;
  expected?: string | undefined;
  notice?: string | undefined;
}) {
  const communityCatalog = catalogSession?.communityCatalog;
  useEffect(() => {
    if (communityCatalog?.available()) return communityCatalog.retain();
  }, [communityCatalog]);
  const publications = useSyncExternalStore(
    communityCatalog?.subscribe ?? emptySubscribe,
    communityCatalog?.snapshot ?? emptyCatalogSnapshot,
    communityCatalog?.snapshot ?? emptyCatalogSnapshot,
  );
  const [selectedCoordinate, setSelectedCoordinate] = useState<string>();
  const selectedPublication = publications.teams.find(
    (entry) => `${entry.owner}:${entry.d}` === selectedCoordinate,
  );
  const alreadyAdded =
    !!selectedPublication &&
    !!catalogSession &&
    catalogAlreadyAdded(catalogSession, selectedPublication, (id) =>
      kit
        .snapshot()
        .entries.some(
          (entry) =>
            !entry.record.deleted &&
            entry.record.value.type === "team" &&
            entry.record.value.id === id,
        ),
    );
  const [catalogError, setCatalogError] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const nameInput = useRef<HTMLInputElement>(null);
  const state = useSyncExternalStore(kit.subscribe, kit.snapshot);
  const [draft, setDraft] = useState<Team | Template>(() =>
    structuredClone(initial),
  );
  const [portable, setPortable] = useState<TeamSnapshot>();
  const [loading, setLoading] = useState(
    initial.type === "team" && !!initial.portable,
  );
  const revision = useRef(crypto.randomUUID());
  const prepared = useRef<TeamSnapshot | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      kit.ensure();
    }
  }, [open, kit]);
  useEffect(() => {
    if (initial.type !== "team" || !initial.portable) return;
    let cancelled = false;
    void kit
      .loadTeam(initial)
      .then(async (value) => {
        if (!control?.previewTeam)
          throw new Error("Team preview is unavailable");
        const snapshot = await control.previewTeam(JSON.stringify(value));
        if (snapshot.members.length !== initial.agents.length)
          throw new Error(
            "Portable team members do not match their definitions",
          );
        if (!cancelled) {
          setPortable(snapshot);
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [initial, kit, control]);
  const localMembers = sameCommunityAgents(
    control?.captureTeam ? (control.snapshot().data?.agents ?? []) : [],
    session?.scope ?? "",
  );
  const canCapture =
    draft.type === "team" &&
    !expected &&
    !!control?.captureTeam &&
    draft.agents.length > 0 &&
    draft.agents.every((key) =>
      localMembers.some((agent) => agent.pubkey === key),
    );
  const hasPortableFields =
    !!portable?.team.description?.trim() ||
    !!portable?.team.instructions?.trim();
  const save = async () => {
    if (!live.current || !active() || loading || catalogBusy) return;
    setBusy(true);
    setError("");
    try {
      if (
        draft.type === "team" &&
        ((initial.type === "team" && initial.portable) || canCapture)
      ) {
        if (!session?.viewer)
          throw new Error("Choose a community before saving a team");
        const community = relayOrigin(
          session.scope.slice(0, -(session.viewer.length + 1)),
        );
        const previous =
          initial.type === "team" && initial.portable ? initial.agents : [];
        const added = draft.agents.filter(
          (pubkey) => !portable || !previous.includes(pubkey),
        );
        const captured =
          !prepared.current && added.length
            ? await control?.captureTeam?.(
                { name: draft.name },
                added,
                community,
              )
            : undefined;
        const members =
          prepared.current?.members ??
          draft.agents.map((pubkey) => {
            const index = previous.indexOf(pubkey);
            const member =
              portable && index >= 0
                ? portable.members[index]
                : captured?.members[added.indexOf(pubkey)];
            if (!member)
              throw new Error("A selected agent has no portable definition");
            return member;
          });
        const snapshot: TeamSnapshot = {
          format: "buzz-team-snapshot",
          version: 1,
          team: { ...portable?.team, name: draft.name },
          members,
        };
        prepared.current = snapshot;
        await kit.savePortable(draft, snapshot, expected, revision.current);
      } else {
        if (hasPortableFields)
          throw new Error(
            "Description and team instructions require nonempty local team members",
          );
        await kit.save(draft, expected);
      }
      if (live.current && active()) onOpenChange(false);
    } catch (reason) {
      if (live.current && active())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (live.current && active()) setBusy(false);
    }
  };
  return (
    <Dialog
      dismissOnOutsideClick
      open={open}
      finalFocus={finalFocus}
      onOpenChange={(next) => {
        if (!next && !catalogBusy && live.current && active())
          onOpenChange(false);
      }}
      preventClose={busy || catalogBusy}
      initialFocus={nameInput}
      title={`${expected ? "Edit" : draft.type === "team" ? "Add" : "New"} ${draft.type}`}
      description={
        draft.type === "team"
          ? "Choose agents to reuse together in future channels and @mentions. This team is private to you in this community."
          : "Save a starting setup for future channels. Applying a template copies it once; existing channels stay unchanged."
      }
      closeLabel="Close templates"
      actions={
        <>
          <Button
            disabled={busy || catalogBusy}
            onClick={() => {
              if (live.current && active()) onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={busy}
            disabled={
              !draft.name.trim() ||
              state.status !== "ready" ||
              loading ||
              catalogBusy
            }
            onClick={() => void save()}
          >
            Save {draft.type}
          </Button>
        </>
      }
    >
      <div
        className={
          onImport || catalogSession ? styles.teamAddLayout : undefined
        }
      >
        {(onImport || catalogSession) && (
          <nav aria-label="Add team" className={styles.teamAddSidebar}>
            <NavigationItem
              label="Create team"
              aria-label="Create new team"
              icon={<PlusIcon size={16} />}
              selected={!selectedCoordinate}
              disabled={catalogBusy || !!draft.name || draft.agents.length > 0}
              onClick={() => setSelectedCoordinate(undefined)}
            />
            {onImport && (
              <Button
                variant="outline"
                size="sm"
                disabled={
                  catalogBusy || !!draft.name || draft.agents.length > 0
                }
                onClick={onImport}
              >
                Import
              </Button>
            )}
            {publications.teams.length > 0 && (
              <span className="text-label text-subtle">TEAMS</span>
            )}
            {publications.teams.map((team) => (
              <NavigationItem
                key={team.eventId}
                label={team.name}
                selected={selectedCoordinate === `${team.owner}:${team.d}`}
                disabled={
                  catalogBusy || !!draft.name || draft.agents.length > 0
                }
                onClick={() => setSelectedCoordinate(`${team.owner}:${team.d}`)}
              />
            ))}
            {publications.status === "error" && (
              <p role="alert">{publications.error}</p>
            )}
          </nav>
        )}
        {selectedCoordinate ? (
          <section
            aria-label={selectedPublication?.name ?? "Withdrawn team"}
            className="team-catalog-preview"
          >
            {selectedPublication && catalogSession ? (
              <TeamCatalogPreview
                publication={selectedPublication}
                session={catalogSession}
              />
            ) : (
              <p role="status">
                This team is no longer shared. Select another team.
              </p>
            )}
            {selectedPublication &&
              unsupportedTransport(selectedPublication) && (
                <p role="note">
                  {unsupportedTransportMessage(
                    selectedPublication.name,
                    unsupportedTransport(selectedPublication) ?? "",
                  )}
                </p>
              )}
            {catalogError && <p role="alert">{catalogError}</p>}
            <Button
              variant="prominent"
              disabled={
                !selectedPublication ||
                alreadyAdded ||
                catalogBusy ||
                !!(
                  selectedPublication &&
                  unsupportedTransport(selectedPublication)
                ) ||
                !onAddCatalogTeam
              }
              onClick={() => {
                if (
                  !onAddCatalogTeam ||
                  !catalogSession ||
                  !selectedPublication ||
                  alreadyAdded ||
                  catalogBusy ||
                  !live.current ||
                  !active()
                )
                  return;
                const selected = selectedPublication;
                setCatalogBusy(true);
                setCatalogError("");
                void onAddCatalogTeam(selected)
                  .then((copy) => {
                    if (!live.current || !active()) return;
                    rememberAdded(
                      catalogSession.scope,
                      catalogSession.viewer ?? "",
                      selected,
                      copy,
                    );
                    onOpenChange(false);
                  })
                  .catch((cause) => {
                    if (live.current && active())
                      setCatalogError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                  })
                  .finally(() => {
                    if (live.current && active()) setCatalogBusy(false);
                  });
              }}
            >
              {alreadyAdded
                ? "Added to my teams"
                : catalogBusy
                  ? "Adding…"
                  : "Add team"}
            </Button>
          </section>
        ) : (
          <div className={styles.stack} inert={busy || loading}>
            {notice && <p role="status">{notice}</p>}
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            {state.status !== "ready" && (
              <p role="status">
                {state.error ??
                  (state.status === "unavailable"
                    ? "This host does not support saved templates."
                    : "Loading your saved templates…")}
              </p>
            )}
            <Field label="Name">
              <Input
                ref={nameInput}
                placeholder={
                  draft.type === "team" ? "Engineering Squad" : undefined
                }
                maxLength={120}
                value={draft.name}
                onChange={(e) => {
                  revision.current = crypto.randomUUID();
                  prepared.current = undefined;
                  setDraft({ ...draft, name: e.target.value });
                }}
              />
            </Field>
            {draft.type === "team" ? (
              <>
                {((initial.type === "team" && initial.portable) ||
                  canCapture ||
                  hasPortableFields) && (
                  <>
                    <Field label="Description">
                      <Textarea
                        placeholder="Optional description for this team."
                        value={portable?.team.description ?? ""}
                        onChange={(event) => {
                          revision.current = crypto.randomUUID();
                          prepared.current = undefined;
                          setPortable((value) => ({
                            ...(value ?? {
                              format: "buzz-team-snapshot",
                              version: 1,
                              members: [],
                            }),
                            team: {
                              ...value?.team,
                              name: draft.name,
                              description: event.target.value,
                            },
                          }));
                        }}
                      />
                    </Field>
                    <Field label="Team Instructions">
                      <Textarea
                        placeholder="Optional instructions applied to every deployed team member."
                        value={portable?.team.instructions ?? ""}
                        onChange={(event) => {
                          revision.current = crypto.randomUUID();
                          prepared.current = undefined;
                          setPortable((value) => ({
                            ...(value ?? {
                              format: "buzz-team-snapshot",
                              version: 1,
                              members: [],
                            }),
                            team: {
                              ...value?.team,
                              name: draft.name,
                              instructions: event.target.value,
                            },
                          }));
                        }}
                      />
                    </Field>
                  </>
                )}
                {loading && <p role="status">Loading team definitions…</p>}
                <AgentSelection
                  session={session}
                  agents={agents}
                  selected={draft.agents}
                  onChange={(agents) => {
                    revision.current = crypto.randomUUID();
                    prepared.current = undefined;
                    setDraft({ ...draft, agents });
                  }}
                />
              </>
            ) : (
              <>
                <Field
                  label="Description"
                  description="Optional. A short reminder of what this template is for."
                >
                  <Input
                    maxLength={1000}
                    value={draft.description}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                </Field>
                <TemplateFields
                  session={session}
                  value={draft}
                  onChange={(value) => setDraft({ ...draft, ...value })}
                  entries={state.entries}
                  agents={agents}
                />
              </>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const emptySubscribe = () => () => {};
const emptyCatalog = { status: "unavailable" as const, agents: [], teams: [] };
const emptyCatalogSnapshot = () => emptyCatalog;
