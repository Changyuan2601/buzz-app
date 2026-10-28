// Map Node emit times into recording time and pair each with the first
// rendering update in which its row intersects the viewport.
export function arrivalLatencies({ frames, startMs }, emits, offsetMs) {
  const firstVisible = new Map();
  for (const frame of frames)
    for (const [id] of frame.rows)
      if (!firstVisible.has(id)) firstVisible.set(id, frame.t);
  return emits.map(({ id, at }) => {
    const emitT = at + offsetMs - startMs;
    const visibleT = firstVisible.get(id);
    return {
      id,
      emitT,
      visibleT,
      latencyMs: visibleT === undefined ? undefined : visibleT - emitT,
    };
  });
}

export function latencySummary(arrivals) {
  const sorted = arrivals
    .map(({ latencyMs }) => latencyMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) throw new Error("No arrival became visible");
  const at = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    arrivalP50Ms: at(0.5),
    arrivalP95Ms: at(0.95),
    arrivalMaxMs: sorted.at(-1),
  };
}
