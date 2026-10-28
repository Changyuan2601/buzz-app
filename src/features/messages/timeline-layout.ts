/** Measured row sizes keyed by row identity, so moved rows keep their own size. */
export type TimelineCache = {
  readonly sizes: ReadonlyMap<string, number>;
  readonly estimate: number;
};

const DEFAULT_SIZE = 40;

/**
 * Row offsets for a keyed list. Unmeasured rows take the estimate: 40px until
 * the measured rows exceed one viewport, then their median, as Virtua does.
 */
export function createTimelineLayout(cache?: TimelineCache) {
  let keys: readonly string[] = [];
  const sizes = new Map(cache?.sizes);
  let estimate = cache?.estimate ?? DEFAULT_SIZE;
  let estimating = !cache;
  let measuredTotal = 0;
  const offsets = [0];
  let computed = 0;
  // Space added above the first row: a measurement error absorbed above the
  // mounted rows instead of moving the scroll offset (see TimelineVirtualizer).
  let drift = 0;
  const size = (index: number) => sizes.get(keys[index] ?? "") ?? estimate;
  const offset = (index: number) => {
    const target = Math.max(0, Math.min(index, keys.length));
    while (computed < target) {
      offsets[computed + 1] = (offsets[computed] ?? 0) + size(computed);
      computed++;
    }
    return drift + (offsets[target] ?? 0);
  };
  return {
    keys: () => keys,
    length: () => keys.length,
    estimating: () => estimating,
    drift: () => drift,
    setDrift(next: number) {
      drift = next;
    },
    setKeys(next: readonly string[]) {
      let same = 0;
      const shared = Math.min(next.length, keys.length);
      while (same < shared && next[same] === keys[same]) same++;
      if (same === next.length && same === keys.length) return;
      keys = next;
      computed = Math.min(computed, same);
    },
    size,
    offset,
    total: () => offset(keys.length),
    measured: (index: number) => sizes.has(keys[index] ?? ""),
    sizeOf: (key: string) => sizes.get(key),
    /** The last row starting at or before this offset. */
    find(at: number) {
      let low = 0;
      let high = keys.length - 1;
      let found = 0;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (offset(middle) <= at) {
          found = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      return found;
    },
    setSizes(
      resizes: readonly (readonly [string, number])[],
      viewport: number,
    ) {
      const index = new Map(keys.map((key, at) => [key, at]));
      for (const [key, value] of resizes) {
        const previous = sizes.get(key);
        measuredTotal += value - (previous ?? 0);
        sizes.set(key, value);
        const at = index.get(key);
        if (at !== undefined) computed = Math.min(computed, at);
      }
      if (estimating && viewport && measuredTotal > viewport) {
        const measured = keys.flatMap((key) => {
          const value = sizes.get(key);
          return value ? [value] : [];
        });
        measured.sort((a, b) => a - b);
        const middle = measured.length >> 1;
        if (measured.length)
          estimate =
            measured.length % 2
              ? (measured[middle] ?? estimate)
              : ((measured[middle - 1] ?? 0) + (measured[middle] ?? 0)) / 2;
        estimating = false;
        computed = 0;
      }
    },
    snapshot(): TimelineCache {
      const kept = new Map<string, number>();
      for (const key of keys) {
        const value = sizes.get(key);
        if (value !== undefined) kept.set(key, value);
      }
      return { sizes: kept, estimate };
    },
  };
}
export type TimelineLayout = ReturnType<typeof createTimelineLayout>;
