import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { Switch } from "../shared/design-system/ui/Switch";
import { Button } from "../shared/design-system/ui/Button";
import { Accordion } from "../shared/design-system/ui/Accordion";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { readPluginFolder } from "./plugin-folder-drop";
import styles from "./PluginImport.module.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FolderOpenIcon,
  GlobeIcon,
  PlugIcon,
  TerminalWindowIcon,
  MonitorIcon,
} from "../shared/design-system/icons/index";
import type { PluginManager } from "../plugins/manager";
import type { Catalog, ImportPreview } from "../plugins/types";
import type { PluginManifest } from "../plugins/api";

function importLocation(preview: ImportPreview, path: string | undefined) {
  if (!path || path === ".") return preview.source;
  if (preview.commit) return `${preview.source} · ${path}`;
  const windows = /^(?:[a-z]:\\|\\\\)/i.test(preview.source);
  const separator = windows ? "\\" : "/";
  const source = preview.source.replace(windows ? /\\+$/ : /\/+$/, "");
  return `${source}${separator}${path.replaceAll("/", separator)}`;
}

function ProgramDetails({
  program,
  args,
}: {
  program: string;
  args: readonly string[];
}) {
  return (
    <>
      <p className="mb-2 mt-1">
        Program: <code>{program}</code>
      </p>
      <p className="mb-1 mt-0">Arguments{args.length ? ":" : ": none"}</p>
      {args.length > 0 && (
        <ol className="m-0 list-decimal space-y-2 pl-6">
          {args.map((argument, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: Argument position is its identity; repeated values are valid.
              key={index}
              aria-label={`Argument ${index + 1}`}
            >
              <pre className="m-0 whitespace-pre-wrap break-words">
                <code>{argument}</code>
              </pre>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function hostDeclarations(manifest: PluginManifest) {
  return [
    ...(manifest.host?.commands ?? []).map((command) => ({
      signature: `Command ${command.id}: ${JSON.stringify([command.program, ...command.args])} · input: ${command.maxInputBytes === undefined ? "none" : `up to ${command.maxInputBytes} bytes`} · output: up to ${command.maxOutputBytes ?? 4096} bytes`,
      title: `Command ${command.id}:`,
      label: `Run ${command.program}`,
      hint: "Run a program on your computer.",
      icon: TerminalWindowIcon,
      details: (
        <>
          <ProgramDetails program={command.program} args={command.args} />
          <p className="mb-0 mt-2">
            Input:{" "}
            {command.maxInputBytes === undefined
              ? "none"
              : `up to ${command.maxInputBytes} bytes`}
          </p>
          <p className="m-0">
            Output: up to {command.maxOutputBytes ?? 4096} bytes
          </p>
        </>
      ),
    })),
    ...(manifest.host?.networkOrigins ?? []).map((origin) => ({
      signature: `HTTPS origin: ${origin}`,
      title: "HTTPS origin:",
      name: `HTTPS origin ${origin}`,
      label: `Connect to ${origin}`,
      hint: "Buzz can make HTTPS requests to this address for the plugin.",
      icon: GlobeIcon,
      details: <code className="break-words">{origin}</code>,
    })),
    ...(manifest.host?.processes ?? []).map((process) => ({
      signature: `Process ${process.id}: ${JSON.stringify([process.program, ...(process.args ?? [])])}${process.bundled ? " (bundled with Buzz)" : ""} and any further arguments · stdin, full user access`,
      title: `Process ${process.id}:`,
      label: `Start ${process.program}`,
      hint: "Can start a background process with additional arguments, using your account’s full access.",
      icon: TerminalWindowIcon,
      details: (
        <>
          <ProgramDetails program={process.program} args={process.args ?? []} />
          {process.bundled && <p className="mb-0 mt-2">Bundled with Buzz.</p>}
          <p className="mb-0 mt-2">
            Allows further arguments and standard input, with your account’s
            full access.
          </p>
        </>
      ),
    })),
    ...(manifest.host?.mcp
      ? [
          {
            signature:
              "MCP servers: tools served to local agents over loopback HTTP",
            title: "MCP servers:",
            label: "Provide tools to local agents",
            hint: "Exposes plugin tools through Buzz’s local MCP server.",
            icon: PlugIcon,
            details: (
              <p className="m-0">
                Tools served to local agents over loopback HTTP.
              </p>
            ),
          },
        ]
      : []),
    ...(manifest.host?.files
      ? [
          {
            signature:
              "Files: read any file and resolve folders · full user access",
            title: "Files:",
            label: "Read your files",
            hint: "Can read any file your account can, and create folders it resolves.",
            icon: FolderOpenIcon,
            details: (
              <p className="m-0">
                Reads files and resolves folders with your account’s full
                access.
              </p>
            ),
          },
        ]
      : []),
  ];
}

export function PluginImport({
  plugins,
  catalog,
  busy,
  authorizeGit,
  actionTarget,
  updateId,
  onClosed,
  returnFocus,
}: {
  plugins: PluginManager;
  catalog: Catalog;
  busy: boolean;
  actionTarget?: HTMLElement | null;
  updateId?: string;
  onClosed?: () => void;
  returnFocus?: () => HTMLElement | null;
  /** Signs in to the selected community's Buzz git; null for other repositories. */
  authorizeGit?: (
    repository: string,
  ) => Promise<{ repository: string; token: string } | null>;
}) {
  const imports = plugins.imports;
  const [open, setOpen] = useState(!!updateId);
  const [dragging, setDragging] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [repository, setRepository] = useState("");
  const [reference, setReference] = useState("");
  const [loading, setLoading] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const previewRegion = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const browse = useRef<HTMLButtonElement>(null);
  const errorBack = useRef<HTMLButtonElement>(null);
  const previewBack = useRef<HTMLButtonElement>(null);
  const sourceTrigger = useRef<HTMLElement | null>(null);
  const installButton = useRef<HTMLButtonElement>(null);
  const errorReturnsToBack = useRef(false);
  useLayoutEffect(() => {
    if (!open || loading || discarding) return;
    if (preview) {
      const checked = !reviewing
        ? previewRegion.current?.querySelector<HTMLElement>(
            '[role="radio"][aria-checked="true"], input[type="radio"]:checked',
          )
        : null;
      (checked ?? previewBack.current)?.focus();
    } else if (sourceTrigger.current) {
      if (sourceTrigger.current === document.body) browse.current?.focus();
      else sourceTrigger.current.focus();
      sourceTrigger.current = null;
    }
  }, [open, preview, loading, discarding, reviewing]);
  const errorTrigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (busy || loading || discarding) return;
    if (error) errorBack.current?.focus();
    else if (errorTrigger.current) {
      if (errorTrigger.current === document.body) browse.current?.focus();
      else if (errorTrigger.current.isConnected) errorTrigger.current.focus();
      else if (errorReturnsToBack.current) previewBack.current?.focus();
      else (installButton.current ?? previewBack.current)?.focus();
      errorTrigger.current = null;
    }
  }, [error, busy, loading, discarding]);
  // Pending operations disable their control, so callers capture the return
  // target before starting rather than reading focus when the failure arrives.
  function showError(reason: unknown, returnTo: Element | null) {
    if (!error) {
      errorTrigger.current = returnTo as HTMLElement | null;
      errorReturnsToBack.current = returnTo === previewBack.current;
    }
    setError(String(reason));
  }
  const [enableOnInstall, setEnableOnInstall] = useState(true);
  const lifetime = useRef({ active: true, token: "" });
  const pending = useRef(false);
  useEffect(() => {
    const current = { active: true, token: "" };
    lifetime.current = current;
    return () => {
      current.active = false;
      if (current.token) void imports?.discard(current.token).catch(() => {});
    };
  }, [imports]);

  const blocked = busy || loading || discarding;
  if (!imports) return null;

  async function load(operation: () => Promise<ImportPreview | null>) {
    if (pending.current || blocked) return;
    const returnTo = document.activeElement as HTMLElement | null;
    sourceTrigger.current = returnTo;
    pending.current = true;
    const current = lifetime.current;
    setLoading(true);
    setError(null);
    setPreview(null);
    setEnableOnInstall(true);
    try {
      const result = await operation();
      const next =
        result && updateId
          ? {
              ...result,
              candidates: result.candidates.filter(
                (item) => item.manifest.id === updateId,
              ),
            }
          : result;
      if (!current.active) {
        if (next) await imports?.discard(next.token);
        return;
      }
      current.token = next?.token ?? "";
      if (next && updateId) {
        if (!next.candidates.length) {
          await imports?.discard(next.token);
          current.token = "";
          throw new Error(
            "This source does not contain the selected plugin. Choose its built folder or repository.",
          );
        }
      }
      setPreview(next);
      setReviewing(next?.candidates.length === 1);
      setSelected(
        next?.candidates.length === 1 ? (next.candidates[0]?.path ?? "") : "",
      );
    } catch (reason) {
      if (current.active) showError(reason, returnTo);
    } finally {
      pending.current = false;
      if (current.active) setLoading(false);
    }
  }
  async function dismiss() {
    if (blocked || pending.current || !preview) return;
    pending.current = true;
    setDiscarding(true);
    try {
      await imports?.discard(preview.token);
      lifetime.current.token = "";
      setPreview(null);
    } catch (reason) {
      showError(reason, previewBack.current);
    } finally {
      pending.current = false;
      setDiscarding(false);
    }
  }
  async function close() {
    if (blocked || pending.current) return;
    const returnTo = document.activeElement;
    pending.current = true;
    setDiscarding(true);
    try {
      if (lifetime.current.token)
        await imports?.discard(lifetime.current.token);
      lifetime.current.token = "";
      setPreview(null);
      errorTrigger.current = null;
      setError(null);
      setDragging(false);
      setOpen(false);
      onClosed?.();
    } catch (reason) {
      showError(reason, returnTo);
    } finally {
      pending.current = false;
      setDiscarding(false);
    }
  }
  const candidate = preview?.candidates.find((p) => p.path === selected);
  const existing = catalog.plugins.find(
    (p) => p.manifest.id === candidate?.manifest.id,
  );
  const rollbackNotice =
    candidate?.publisher && existing && !existing.hasSignature
      ? "You cannot roll back to the unsigned revision after this update."
      : candidate?.revision === existing?.revision &&
          existing?.rollbackBlockedReason
        ? `${existing.rollbackBlockedReason}.`
        : existing?.previous || existing?.revision !== candidate?.revision
          ? "You can still roll back."
          : "There is no earlier revision to roll back to.";
  const declaredDetails = candidate ? hostDeclarations(candidate.manifest) : [];
  const previousDetails = existing ? hostDeclarations(existing.manifest) : [];
  const declaredGrants = declaredDetails.map((grant) => grant.signature);
  const previousGrants = previousDetails.map((grant) => grant.signature);
  const removedDetails = previousDetails.filter(
    (grant) => !declaredGrants.includes(grant.signature),
  );
  function scopeItem(
    grant: ReturnType<typeof hostDeclarations>[number],
    removed = false,
  ) {
    const changed =
      !!updateId &&
      !!existing &&
      !removed &&
      !previousGrants.includes(grant.signature);
    const Icon = grant.icon;
    return {
      value: grant.signature,
      title: (
        <span className="flex items-start gap-3 text-left text-body-sm break-words">
          <Icon size={20} aria-hidden="true" className="shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block font-medium">
              {removed ? "Removed: " : ""}
              {grant.label}
              {changed ? " (new or changed)" : ""}
            </span>
            <span className="block text-muted">{grant.hint}</span>
          </span>
        </span>
      ),
      content: (
        <section
          aria-label={`${removed ? "Removed " : ""}${"name" in grant ? grant.name : grant.title.slice(0, -1)} details`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard access to long command details.
          tabIndex={0}
          className={styles.technicalDetails}
        >
          <p className="m-0 font-medium">
            {grant.title}
            {changed ? " (new or changed)" : ""}
          </p>
          {grant.details}
        </section>
      ),
    };
  }
  const addButton = (
    <Button
      ref={trigger}
      size="sm"
      aria-label={
        updateId
          ? `Update ${catalog.plugins.find((item) => item.manifest.id === updateId)?.manifest.name ?? "plugin"}`
          : undefined
      }
      disabled={blocked}
      onClick={() => setOpen(true)}
    >
      {updateId ? "Update" : "Add"}
    </Button>
  );
  return (
    <>
      {!updateId &&
        (actionTarget ? createPortal(addButton, actionTarget) : addButton)}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void close();
        }}
        title={
          error || !preview
            ? updateId
              ? "Update plugin"
              : "Add a plugin"
            : reviewing
              ? "Review plugin access"
              : preview.candidates.length
                ? "Choose a plugin"
                : "No plugins found"
        }
        description={
          error
            ? undefined
            : preview
              ? reviewing
                ? "Only install code you trust."
                : preview.candidates.length
                  ? "Select a plugin to review before installing."
                  : "Try another folder or repository."
              : "Choose a built plugin to load."
        }
        size={error ? "default" : "wide"}
        leadingActions={
          reviewing &&
          candidate &&
          !updateId &&
          (!existing || loading) &&
          !error ? (
            <Switch
              label="Enable plugin"
              checked={enableOnInstall}
              disabled={blocked}
              onCheckedChange={setEnableOnInstall}
            />
          ) : undefined
        }
        actions={
          error ? (
            <Button
              ref={errorBack}
              type="button"
              disabled={blocked}
              onClick={() => setError(null)}
            >
              Back
            </Button>
          ) : preview ? (
            <>
              <Button
                ref={previewBack}
                type="button"
                disabled={blocked}
                onClick={() => {
                  if (reviewing && preview.candidates.length > 1) {
                    setReviewing(false);
                  } else void dismiss();
                }}
              >
                Back
              </Button>
              {!reviewing && preview.candidates.length > 1 && (
                <Button
                  variant="prominent"
                  type="button"
                  disabled={blocked || !candidate}
                  onClick={() => setReviewing(true)}
                >
                  Continue
                </Button>
              )}
              {reviewing && candidate && (
                <Button
                  ref={installButton}
                  variant="prominent"
                  type="button"
                  disabled={blocked || (!!existing && !updateId)}
                  onClick={async () => {
                    if (blocked || pending.current) return;
                    const current = lifetime.current;
                    pending.current = true;
                    setLoading(true);
                    setError(null);
                    try {
                      const success = await plugins.installImport(
                        preview.token,
                        candidate.path,
                      );
                      if (!current.active) return;
                      if (!success) {
                        showError(
                          plugins.snapshot().error ??
                            "Plugin installation wasn’t confirmed. Check the preview and try again.",
                          installButton.current,
                        );
                        return;
                      }
                      // Native keeps the prepared preview after install.
                      current.token = "";
                      void imports.discard(preview.token).catch(() => {});
                      if (!existing && enableOnInstall)
                        await plugins.change("enable", candidate.manifest.id);
                      if (!current.active) return;
                      setPreview(null);
                      setOpen(false);
                      onClosed?.();
                    } finally {
                      pending.current = false;
                      if (current.active) setLoading(false);
                    }
                  }}
                >
                  {updateId ? "Update plugin" : "Install plugin"}
                </Button>
              )}
            </>
          ) : undefined
        }
        dismissOnOutsideClick
        preventClose={blocked}
        finalFocus={() => returnFocus?.() ?? trigger.current}
      >
        {error && (
          <p role="alert" className="error break-words">
            {error}
          </p>
        )}
        <div hidden={!!error}>
          <div hidden={!!preview}>
            <p className="mb-4 mt-0 text-body-sm text-muted">
              Load built plugins containing manifest.json and plugin.js. Buzz
              doesn’t build source code or run install scripts.
            </p>
            <div className={styles.columns}>
              <section
                aria-label="Add from folder"
                className={styles.folder}
                data-dragging={dragging || undefined}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = blocked ? "none" : "copy";
                  setDragging(!blocked);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDragging(false);
                  const items = Array.from(event.dataTransfer.items);
                  const entry =
                    items.length === 1 ? items[0]?.webkitGetAsEntry?.() : null;
                  const current = lifetime.current;
                  void load(async () => {
                    if (!entry?.isDirectory)
                      throw new Error("Drop one folder, or choose Browse.");
                    const upload = await readPluginFolder(entry);
                    if (!current.active) return null;
                    const next = await imports.files(
                      upload.source,
                      upload.files,
                    );
                    return next
                      ? {
                          ...next,
                          warnings: [...upload.warnings, ...next.warnings],
                        }
                      : null;
                  });
                }}
              >
                <FolderOpenIcon size={32} aria-hidden="true" />
                <p className="m-0 text-body-sm">Drop a plugin folder here</p>
                <Button
                  size="sm"
                  ref={browse}
                  aria-label="Browse plugin folder"
                  disabled={blocked}
                  onClick={() => void load(imports.folder)}
                >
                  Browse
                </Button>
              </section>
              <form
                aria-label="Add from Git"
                className={styles.git}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (repository.trim())
                    void load(async () => {
                      const signed = await authorizeGit?.(repository);
                      return signed
                        ? imports.git(
                            signed.repository,
                            reference,
                            signed.token,
                          )
                        : imports.git(repository, reference);
                    });
                }}
              >
                <SettingsGroup layout="form">
                  <Field label="Git or GitHub repository">
                    <Input
                      required
                      value={repository}
                      disabled={blocked}
                      placeholder="https://github.com/owner/repository"
                      onChange={(event) => setRepository(event.target.value)}
                    />
                  </Field>
                  <Field label="Branch or tag (optional)">
                    <Input
                      value={reference}
                      disabled={blocked}
                      placeholder="Repository default"
                      onChange={(event) => setReference(event.target.value)}
                    />
                  </Field>
                  <p className="m-0 text-caption text-muted">
                    HTTPS or SSH; GitHub owner/repository also works. SSH uses
                    your agent and known hosts. Password prompts and credential
                    helpers are not used. Buzz git repositories in this
                    community sign in with your account.
                  </p>
                  <div className="justify-self-start">
                    <Button
                      type="submit"
                      size="sm"
                      aria-label="Find plugins"
                      disabled={blocked || !repository.trim()}
                    >
                      Find
                    </Button>
                  </div>
                </SettingsGroup>
              </form>
            </div>
          </div>
          {loading && !preview && (
            <p role="status">
              Reading plugin folders… Git imports may take up to a minute.
            </p>
          )}
          {loading && preview && (
            <p role="status">
              {updateId ? "Updating plugin…" : "Installing plugin…"}
            </p>
          )}
          {preview && (
            <section ref={previewRegion} aria-label="Plugin import preview">
              <div className="flex flex-col gap-4">
                {!reviewing &&
                  (preview.candidates.length === 0 || preview.commit) && (
                    <div className="min-w-0 text-body-sm">
                      {preview.candidates.length === 0 && (
                        <p className="m-0 break-all text-caption text-muted">
                          Source: {preview.source}
                        </p>
                      )}
                      {preview.commit && (
                        <p className="m-0 break-all text-caption text-muted">
                          Commit: {preview.commit}
                        </p>
                      )}
                    </div>
                  )}
                {preview.candidates.length === 0 ? (
                  <p className="m-0">
                    No built plugins found. Build the plugin first, then choose
                    its output folder, or use a repository that includes built
                    artifacts.
                  </p>
                ) : !reviewing && preview.candidates.length > 1 ? (
                  <Field label="Choose a plugin" labelVisibility="hidden">
                    <RadioGroup
                      name="plugin-folder"
                      aria-label="Choose a plugin"
                      value={selected}
                      disabled={busy}
                      onValueChange={(value) => {
                        setSelected(value);
                      }}
                    >
                      {preview.candidates.map((item) => (
                        <Radio
                          key={item.path}
                          value={item.path}
                          variant="card"
                          label={item.manifest.name}
                          description={
                            <span className="block break-all text-caption text-muted">
                              {importLocation(preview, item.path)} ·{" "}
                              {item.manifest.id}
                            </span>
                          }
                        />
                      ))}
                    </RadioGroup>
                  </Field>
                ) : null}
                {preview.warnings.length > 0 &&
                  (!reviewing || preview.candidates.length === 1) && (
                    <section
                      aria-label="Skipped folders"
                      className="text-body-sm"
                    >
                      <p className="m-0 text-label">
                        Folders skipped ({preview.warnings.length})
                      </p>
                      <p className="mb-0 mt-1 text-muted">
                        These folders couldn’t be loaded as plugins. Other
                        listed plugins can still be installed.
                      </p>
                      <ul className="mb-0 mt-2 list-disc space-y-1 break-words pl-4">
                        {preview.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                {reviewing &&
                  candidate &&
                  (!existing || updateId || loading) && (
                    <section
                      aria-label="Computer access"
                      className="text-body-sm"
                    >
                      <Accordion
                        animate
                        key={`computer-${selected}`}
                        items={[
                          {
                            value: "computer-access",
                            title: (
                              <span className="flex items-start gap-3 text-left text-body-sm">
                                <MonitorIcon
                                  size={20}
                                  className="shrink-0 text-muted"
                                  aria-hidden="true"
                                />
                                <span>
                                  <span className="block font-medium">
                                    Computer access
                                  </span>
                                  <span className="block text-muted">
                                    Can access files and run programs on your
                                    computer.
                                  </span>
                                </span>
                              </span>
                            ),
                            content: (
                              <section
                                aria-label="Plugin safety"
                                className="max-w-prose pl-8 text-body"
                              >
                                <h4 className="mb-2 mt-0 text-label">
                                  Access beyond this list
                                </h4>
                                <p className="m-0">
                                  Plugins aren’t sandboxed. They can access your
                                  computer beyond these declarations, even when
                                  no additional capabilities are listed.
                                </p>
                                <p className="mb-0 mt-3 text-muted">
                                  These declarations describe what the plugin
                                  asks Buzz to do. They don’t limit what its
                                  code can do.
                                </p>
                              </section>
                            ),
                          },
                        ]}
                      />
                      {updateId &&
                        existing &&
                        (declaredGrants.some(
                          (grant) => !previousGrants.includes(grant),
                        ) ||
                          previousGrants.some(
                            (grant) => !declaredGrants.includes(grant),
                          )) && (
                          <p className="my-2">
                            Computer access changes with this update. Expand a
                            scope to review its exact declaration.
                          </p>
                        )}
                      {declaredDetails.length ? (
                        <section aria-label="Declared scopes">
                          <Accordion
                            animate
                            key={selected}
                            items={declaredDetails.map((grant) =>
                              scopeItem(grant),
                            )}
                          />
                        </section>
                      ) : (
                        <p className="m-0">
                          No additional capabilities declared.
                        </p>
                      )}
                      {updateId && removedDetails.length > 0 && (
                        <section
                          aria-label="Removed declarations"
                          className="mt-4"
                        >
                          <p className="m-0 font-medium">Removed:</p>
                          <Accordion
                            animate
                            items={removedDetails.map((grant) =>
                              scopeItem(grant, true),
                            )}
                          />
                        </section>
                      )}
                    </section>
                  )}
                {reviewing && existing && !updateId && !loading && (
                  <p className="m-0 text-body-sm">
                    This plugin is already installed. Use Update from its row on
                    the Plugins page.
                  </p>
                )}
                {reviewing && candidate && existing && updateId && (
                  <p className="m-0 text-body-sm">
                    {`This replaces ${existing.manifest.name} (${existing.manifest.id}). ${existing.enabled ? "It stays on and may run immediately unless this launch is in safe mode." : "It stays off."} ${rollbackNotice}`}
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
      </Dialog>
    </>
  );
}
