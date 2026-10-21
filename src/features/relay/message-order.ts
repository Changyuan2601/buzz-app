/** Largest lead over the local clock that other authors' timestamps may impose. */
const MAX_LEAD_MS = 5000;
/** Largest lead this device's own send chain may keep; beyond it (a clock
 * rollback) the chain restarts at the clock. Well inside the relay's ±900s. */
const MAX_OWN_LEAD_MS = 60_000;

/** Sub-second send order: `ms` is a canonical 0–999 offset within the signed second. */
export function eventMs(
  event: Readonly<{ created_at: number; tags: readonly (readonly string[])[] }>,
) {
  const value = event.tags.find(([name]) => name === "ms")?.[1];
  const offset = value && /^(0|[1-9]\d{0,2})$/.test(value) ? Number(value) : 0;
  return event.created_at * 1000 + offset;
}

/** The one rendered message order: effective ms ascending, then event id ascending. */
export function compareMessages(
  a: Readonly<{ id: string; createdAt: number; createdAtMs?: number }>,
  b: Readonly<{ id: string; createdAt: number; createdAtMs?: number }>,
) {
  return (
    (a.createdAtMs ?? a.createdAt * 1000) -
      (b.createdAtMs ?? b.createdAt * 1000) || a.id.localeCompare(b.id)
  );
}

/**
 * Per-session send clock: per-channel high-water marks from rendered evidence
 * (anyone) and from this device's own sends. One relay session owns one clock,
 * so channel keys never mix across communities or viewers.
 */
export class MessageClock {
  private latest = new Map<string, number>();
  private sent = new Map<string, number>();

  /** Record rendered channel/thread evidence so the next send sorts after it. */
  observe(channelId: string, ms: number) {
    if (ms > (this.latest.get(channelId) ?? 0)) this.latest.set(channelId, ms);
  }

  /**
   * Allocate a send time after everything known in the channel. Other authors'
   * evidence may push it at most 5s past the clock; this device's own sends in
   * the channel stay strictly increasing (up to a 60s lead), so a burst never
   * rewinds or ties even when evidence is far in the future.
   */
  next(channelId: string, now = Date.now()) {
    const evidence = Math.min(
      (this.latest.get(channelId) ?? 0) + 1,
      now + MAX_LEAD_MS,
    );
    const own = (this.sent.get(channelId) ?? 0) + 1;
    const ms = Math.max(now, evidence, own - now > MAX_OWN_LEAD_MS ? 0 : own);
    this.sent.set(channelId, ms);
    this.observe(channelId, ms);
    return ms;
  }
}
