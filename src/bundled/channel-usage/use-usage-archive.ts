import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveHost, ArchivePage } from "../../features/archive/types";
import { projectUsageWithUnreadable } from "../../features/agents/usage";

const MAX_RECORDS = 2000;
export function useUsageArchive(
  host: ArchiveHost | undefined,
  channelId: string,
  allowed: boolean,
) {
  const [state, setState] = useState<{
    records: ArchivePage["records"];
    partial: boolean;
    revision: number | null;
    skipped: number;
    status: "loading" | "ready" | "error" | "unavailable";
  }>({
    records: [],
    partial: false,
    revision: null,
    skipped: 0,
    status: host ? "loading" : "unavailable",
  });
  const pending = useRef(false);
  const abort = useRef(new AbortController());
  const generation = useRef(0);
  const permitted = useRef(allowed);
  permitted.current = allowed;
  const reset = useCallback(() => {
    generation.current++;
    abort.current.abort();
    abort.current = new AbortController();
    pending.current = false;
    setState({
      records: [],
      partial: false,
      revision: null,
      skipped: 0,
      status: host ? "loading" : "unavailable",
    });
  }, [host]);
  const load = useCallback(async () => {
    if (!host || !permitted.current || pending.current) return;
    pending.current = true;
    const token = generation.current;
    const signal = abort.current.signal;
    setState((value) => ({ ...value, status: "loading" }));
    let records: ArchivePage["records"] = [];
    let scanned = 0;
    let skipped = 0;
    let before: number | null = null;
    let revision: number | null = null;
    try {
      while (scanned < MAX_RECORDS) {
        const settings = await host.settings(signal);
        if (
          signal.aborted ||
          token !== generation.current ||
          !permitted.current
        )
          return;
        if (revision !== null && settings.revision !== revision) {
          reset();
          setState((value) => ({ ...value, status: "error" }));
          return;
        }
        const page = await host.read(
          { kind: 44200, ...(before !== null ? { before } : {}) },
          signal,
        );
        if (
          signal.aborted ||
          token !== generation.current ||
          !permitted.current
        )
          return;
        // Reject mixed revisions before a fallible trailing settings read.
        if (
          page.revision !== settings.revision ||
          (revision !== null && page.revision !== revision)
        ) {
          reset();
          setState((value) => ({ ...value, status: "error" }));
          return;
        }
        const latest = await host.settings(signal);
        if (
          signal.aborted ||
          token !== generation.current ||
          !permitted.current
        )
          return;
        if (page.revision !== latest.revision) {
          reset();
          setState((value) => ({ ...value, status: "error" }));
          return;
        }
        revision = page.revision;
        records = [...records, ...page.records].slice(0, MAX_RECORDS);
        skipped += page.skipped;
        scanned += page.records.length + page.skipped;
        // A non-advancing cursor must not cause an unbounded read loop.
        if (page.before !== null && before !== null && page.before >= before) {
          setState((value) => ({ ...value, status: "error" }));
          return;
        }
        if (page.before === null || scanned >= MAX_RECORDS) {
          setState({
            records,
            skipped,
            status: "ready",
            partial: page.before !== null && scanned >= MAX_RECORDS,
            revision,
          });
          return;
        }
        before = page.before;
      }
    } catch {
      if (!signal.aborted && token === generation.current && permitted.current)
        setState((value) => ({ ...value, status: "error" }));
    } finally {
      if (token === generation.current) pending.current = false;
    }
  }, [host, reset]);
  useEffect(() => {
    void channelId;
    if (!allowed) {
      reset();
      return;
    }
    reset();
    // Effect setup starts the first page; details toggles do not remount this hook.
    void load();
    return () => {
      generation.current++;
      abort.current.abort();
      pending.current = false;
    };
  }, [allowed, channelId, load, reset]);
  const projection = useMemo(
    () =>
      allowed
        ? projectUsageWithUnreadable(state.records, channelId)
        : { groups: [], unreadable: 0 },
    [allowed, state.records, channelId],
  );
  return {
    groups: projection.groups,
    status: allowed ? state.status : "unavailable",
    partial: allowed && state.partial,
    skipped: allowed ? state.skipped : 0,
    unreadable: projection.unreadable,
    refresh: () => {
      reset();
      void load();
    },
    revision: state.revision,
  };
}
