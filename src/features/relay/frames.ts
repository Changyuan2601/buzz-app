/**
 * Renders a store's changes at the start of the next frame, once for any
 * number of changes before it. A live row then commits before that frame's
 * layout, so lists measure it before a follow scroll, which runs a frame
 * later, and rows arriving with other live state share one commit. Committed
 * from the socket task instead, a row was still unmeasured when the timeline's
 * follow scroll ran; Virtua took the corrected scroll for a reader gesture and
 * remounted the rows behind it when it went idle.
 */
export function subscribeInFrames(
  subscribe: (listener: () => void) => () => void,
) {
  return (listener: () => void) => {
    let frame: number | undefined;
    const release = subscribe(() => {
      // Hidden documents run no frames.
      if (document.visibilityState === "hidden") listener();
      else
        frame ??= requestAnimationFrame(() => {
          frame = undefined;
          listener();
        });
    });
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      release();
    };
  };
}
