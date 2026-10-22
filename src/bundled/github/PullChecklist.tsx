import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircleIcon,
  CircleDashedIcon,
  DotsThreeIcon,
  GitMergeIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "../../shared/design-system/icons/index";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import inlineStyles from "../../shared/InlineReference.module.css";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { loadGitHubChecks, type CheckSummary } from "./checks";
import type { GitHubDetails } from "./data";
import type { GitHubCli } from "./gh";
import { readable } from "./object";
import {
  changePull,
  mergeLabels,
  type MergeMethod,
  type PullAction,
  type PullChecklist as Checklist,
} from "./pull";
import styles from "./GitHub.module.css";

type Tone = "success" | "failure" | "pending" | "neutral";
const toneIcons = {
  success: CheckCircleIcon,
  failure: XCircleIcon,
  pending: WarningCircleIcon,
  neutral: CircleDashedIcon,
};

function Row({
  tone,
  label,
  children,
}: {
  tone: Tone;
  label: string;
  children: ReactNode;
}) {
  const Icon = toneIcons[tone];
  return (
    <li className={styles.checklistRow} data-tone={tone}>
      <Icon size={16} aria-hidden="true" />
      <span className={styles.checklistLabel}>{label}</span>
      <span className={styles.checklistValue}>{children}</span>
    </li>
  );
}

const names = (people: readonly string[]) =>
  people.length > 3
    ? `${people.slice(0, 2).join(", ")} and ${people.length - 2} more`
    : people.join(", ");

function ChecksRow({ checks, url }: { checks: CheckSummary; url: string }) {
  const count = (category: string) =>
    checks.checks?.filter((check) => check.category === category).length ?? 0;
  const failing =
    checks.checks?.filter(
      (check) => check.category === "failing" || check.category === "cancelled",
    ) ?? [];
  const passed = count("successful");
  const running = count("pending");
  const tone: Tone =
    checks.state === "success"
      ? "success"
      : checks.state === "failure"
        ? "failure"
        : checks.state === "pending"
          ? "pending"
          : "neutral";
  const parts = [
    running && `${running} running`,
    passed && `${passed} passed`,
    count("skipped") && `${count("skipped")} skipped`,
  ].filter(Boolean);
  return (
    <Row tone={tone} label="Checks">
      {checks.state === "unavailable" ? (
        "Couldn’t read every check"
      ) : !checks.checks?.length ? (
        "No checks"
      ) : (
        <>
          {!!failing.length && (
            <>
              {failing.length} failed:{" "}
              {failing.slice(0, 3).map((check, index) => (
                <span key={check.key}>
                  {index > 0 && ", "}
                  {check.url ? (
                    <a
                      className={inlineStyles.link}
                      href={check.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {check.name}
                    </a>
                  ) : (
                    check.name
                  )}
                </span>
              ))}
              {failing.length > 3 && (
                <>
                  {", "}
                  <a
                    className={inlineStyles.link}
                    href={`${url}/checks`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {failing.length - 3} more
                  </a>
                </>
              )}
              {!!parts.length && " · "}
            </>
          )}
          {!failing.length && !running && passed
            ? `All ${passed} passed${count("skipped") ? ` · ${count("skipped")} skipped` : ""}`
            : parts.join(" · ")}
        </>
      )}
    </Row>
  );
}

function ReviewRow({ review }: { review: Checklist["review"] }) {
  if (review.decision === "CHANGES_REQUESTED")
    return (
      <Row tone="failure" label="Review">
        Changes requested by {names(review.changes)}
      </Row>
    );
  // GitHub's decision comes first: an approval can still leave a required
  // review (a code owner, or a second approver) outstanding.
  if (review.decision === "REVIEW_REQUIRED")
    return (
      <Row tone="pending" label="Review">
        Required
        {!!review.approved.length && ` · approved by ${names(review.approved)}`}
        {!!review.waiting.length && ` · waiting on ${names(review.waiting)}`}
      </Row>
    );
  if (review.decision === "APPROVED" || review.approved.length)
    return (
      <Row tone="success" label="Review">
        Approved by {names(review.approved)}
      </Row>
    );
  return (
    <Row tone="neutral" label="Review">
      {review.waiting.length
        ? `Waiting on ${names(review.waiting)}`
        : "Not required"}
    </Row>
  );
}

function MergeRow({ pull }: { pull: Checklist }) {
  const base = <span className={styles.branchLabel}>{pull.base}</span>;
  const [tone, text]: [Tone, ReactNode] = (() => {
    switch (pull.merge) {
      case "CLEAN":
      case "HAS_HOOKS":
        return ["success", <>Ready to merge into {base}</>];
      case "UNSTABLE":
        return ["success", <>Can merge into {base}; optional checks failed</>];
      case "BLOCKED":
        return [
          "pending",
          <>
            Blocked by {base}’s rules
            {pull.canBypass && " · you can bypass them"}
          </>,
        ];
      case "BEHIND":
        return ["pending", <>Behind {base}</>];
      case "DIRTY":
        return ["failure", <>Conflicts with {base}</>];
      case "DRAFT":
        return ["neutral", "Draft, so it can’t merge yet"];
      default:
        return ["neutral", "GitHub is still checking"];
    }
  })();
  return (
    <Row tone={tone} label="Merge">
      {text}
    </Row>
  );
}

/** Whether the merge button can merge now, and whether that bypasses rules. */
function mergeability(pull: Checklist) {
  if (pull.state !== "open") return { now: false, bypass: false };
  if (["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pull.merge))
    return { now: true, bypass: false };
  if (["BLOCKED", "BEHIND"].includes(pull.merge) && pull.canBypass)
    return { now: true, bypass: true };
  return { now: false, bypass: false };
}

function Actions({
  pull,
  number,
  title,
  gh,
  refresh,
}: {
  pull: Checklist;
  number: string;
  title: string;
  gh: GitHubCli;
  refresh(): Promise<void>;
}) {
  const [busy, setBusy] = useState<PullAction["type"]>();
  const [error, setError] = useState<string>();
  // What the merge was confirmed against. A refresh that brings a newer push,
  // a new base branch, or a change in whether the merge bypasses branch rules
  // closes the dialog, and the merge itself names the confirmed head.
  const [asked, setConfirming] =
    useState<
      Readonly<{
        method: MergeMethod;
        head: string;
        base: string;
        bypass: boolean;
      }>
    >();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run(action: PullAction, head = pull.head) {
    setBusy(action.type);
    setError(undefined);
    try {
      await changePull(gh, { id: pull.id, head }, action);
      await refresh();
      if (alive.current) setConfirming(undefined);
    } catch (failure) {
      if (alive.current) setError(readable(failure).message);
    } finally {
      if (alive.current) setBusy(undefined);
    }
  }
  const merge = mergeability(pull);
  // A new confirmation starts without an earlier action's error.
  const confirm = (method: MergeMethod) => {
    setError(undefined);
    setConfirming({
      method,
      head: pull.head,
      base: pull.base,
      bypass: merge.bypass,
    });
  };
  const confirming =
    merge.now &&
    asked?.head === pull.head &&
    asked.base === pull.base &&
    asked.bypass === merge.bypass
      ? asked
      : undefined;
  // Forgotten during render, so changing back does not reopen it.
  if (asked && !confirming) setConfirming(undefined);
  const canAutoMerge =
    pull.canEnableAutoMerge &&
    !pull.autoMerge &&
    pull.state === "open" &&
    !["CLEAN", "HAS_HOOKS", "DIRTY"].includes(pull.merge);
  const others = pull.methods.filter((method) => method !== pull.method);
  const menu = [
    ...(merge.now
      ? others.map((method) => (
          <MenuItem key={method} onClick={() => confirm(method)}>
            {mergeLabels[method]}
          </MenuItem>
        ))
      : []),
    ...(canAutoMerge && merge.now
      ? [
          <MenuItem
            key="auto"
            onClick={() =>
              void run({ type: "auto-merge", method: pull.method })
            }
          >
            Merge automatically when ready
          </MenuItem>,
        ]
      : []),
    ...(pull.state === "open" && pull.canUpdate
      ? [
          ...(merge.now || canAutoMerge ? [<MenuSeparator key="split" />] : []),
          <MenuItem key="draft" onClick={() => void run({ type: "draft" })}>
            Convert to draft
          </MenuItem>,
        ]
      : []),
  ];
  return (
    <>
      <div className={styles.pullActions}>
        {pull.state === "draft" && pull.canUpdate && (
          <Button
            variant="prominent"
            size="sm"
            loading={busy === "ready"}
            disabled={!!busy}
            onClick={() => void run({ type: "ready" })}
          >
            Ready for review
          </Button>
        )}
        {pull.autoMerge ? (
          <>
            <span className={styles.pullActionNote}>
              Merges automatically when ready
              {pull.autoMerge.by && ` · set by ${pull.autoMerge.by}`}
            </span>
            {pull.canDisableAutoMerge && (
              <Button
                size="sm"
                loading={busy === "cancel-auto-merge"}
                disabled={!!busy}
                onClick={() => void run({ type: "cancel-auto-merge" })}
              >
                Cancel
              </Button>
            )}
          </>
        ) : merge.now ? (
          <Button
            variant={merge.bypass ? "attention" : "prominent"}
            size="sm"
            disabled={!!busy}
            onClick={() => confirm(pull.method)}
          >
            {mergeLabels[pull.method]}
          </Button>
        ) : (
          canAutoMerge && (
            <Button
              variant="prominent"
              size="sm"
              loading={busy === "auto-merge"}
              disabled={!!busy}
              onClick={() =>
                void run({ type: "auto-merge", method: pull.method })
              }
            >
              Merge when ready
            </Button>
          )
        )}
        {pull.merge === "BEHIND" && pull.canUpdateBranch && (
          <Button
            size="sm"
            loading={busy === "update-branch"}
            disabled={!!busy}
            onClick={() => void run({ type: "update-branch" })}
          >
            Update branch
          </Button>
        )}
        {!!menu.length && (
          <MenuRoot>
            <MenuTrigger
              render={
                <IconButton
                  aria-label="More pull request actions"
                  size="sm"
                  icon={<DotsThreeIcon />}
                  disabled={!!busy}
                />
              }
            />
            <MenuPopup align="end">{menu}</MenuPopup>
          </MenuRoot>
        )}
      </div>
      {error && !confirming && (
        <p role="alert" className={styles.pullActionError}>
          {error}
        </p>
      )}
      {confirming && (
        <AlertDialog
          title={`${mergeLabels[confirming.method]} #${number}?`}
          description={
            confirming.bypass
              ? `${title}. This bypasses ${pull.base}’s branch rules, which haven’t all passed.`
              : `${title}, into ${pull.base} at the commit shown here.`
          }
          pending={busy === "merge"}
          onClose={() => {
            setConfirming(undefined);
            setError(undefined);
          }}
          actions={
            <>
              <Button
                disabled={busy === "merge"}
                onClick={() => {
                  setConfirming(undefined);
                  setError(undefined);
                }}
              >
                Cancel
              </Button>
              <Button
                variant={confirming.bypass ? "attention" : "prominent"}
                loading={busy === "merge"}
                onClick={() =>
                  void run(
                    { type: "merge", method: confirming.method },
                    confirming.head,
                  )
                }
              >
                Merge
              </Button>
            </>
          }
        >
          {error && (
            <p role="alert" className={styles.pullActionError}>
              {error}
            </p>
          )}
        </AlertDialog>
      )}
    </>
  );
}

/** The pull request's state as a short checklist, with the actions that
 * move it on: what someone needs when their agents read the details. */
export function PullChecklist({
  url,
  details,
  checklist,
  gh,
  refresh,
}: {
  url: string;
  details: GitHubDetails;
  checklist: Checklist;
  gh: GitHubCli;
  refresh(): Promise<void>;
}) {
  if (checklist.state === "merged" || checklist.state === "closed")
    return (
      <ul className={styles.checklist} aria-label="Pull request state">
        {checklist.state === "merged" ? (
          <li className={styles.checklistRow} data-tone="merged">
            <GitMergeIcon size={16} aria-hidden="true" />
            <span className={styles.checklistValue}>
              Merged into{" "}
              <span className={styles.branchLabel}>{checklist.base}</span>
              {details.mergedBy && ` by ${details.mergedBy}`}
              {details.mergedAt &&
                ` ${relativeTimestamp(Date.parse(details.mergedAt) / 1000)}`}
            </span>
          </li>
        ) : (
          <Row tone="neutral" label="Closed">
            Without merging
          </Row>
        )}
      </ul>
    );
  return (
    <>
      <ul className={styles.checklist} aria-label="Pull request checklist">
        <ChecksRow checks={checklist.checks} url={url} />
        <ReviewRow review={checklist.review} />
        <Row
          tone={
            checklist.unresolved || checklist.moreThreads
              ? "pending"
              : "success"
          }
          label="Threads"
        >
          {checklist.unresolved || checklist.moreThreads ? (
            <a
              className={inlineStyles.link}
              href={`${url}/files`}
              target="_blank"
              rel="noreferrer"
            >
              {checklist.moreThreads
                ? `${checklist.unresolved} unresolved in the latest 100`
                : `${checklist.unresolved} unresolved`}
            </a>
          ) : (
            "None unresolved"
          )}
        </Row>
        <MergeRow pull={checklist} />
      </ul>
      <Actions
        pull={checklist}
        number={url.split("/").at(-1) ?? ""}
        title={details.title}
        gh={gh}
        refresh={refresh}
      />
    </>
  );
}

/** Without `gh`, only CI can be read for the checklist, from the public API. */
export function PublicChecklist({
  url,
  repository,
  sha,
}: {
  url: string;
  repository: string;
  sha: string | undefined;
}) {
  const [checks, setChecks] = useState<CheckSummary>();
  useEffect(() => {
    if (!sha) return;
    const controller = new AbortController();
    void loadGitHubChecks(
      repository,
      sha,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    ).then((summary) => {
      if (!controller.signal.aborted) setChecks(summary);
    });
    return () => controller.abort();
  }, [repository, sha]);
  return (
    <ul className={styles.checklist} aria-label="Pull request checklist">
      {checks ? (
        <ChecksRow checks={checks} url={url} />
      ) : (
        <Row tone="neutral" label="Checks">
          {sha ? "Loading…" : "Unavailable"}
        </Row>
      )}
    </ul>
  );
}
