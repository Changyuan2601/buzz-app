/** One audio owner across built-in and plugin attachment players, including pending playback. */
let owner: { element: HTMLAudioElement; stop(): void } | undefined;
export function claimAudio(
  element: HTMLAudioElement,
  stop = () => element.pause(),
) {
  if (owner?.element === element) return;
  const previous = owner;
  owner = { element, stop };
  previous?.stop();
}
export function releaseAudio(element: HTMLAudioElement | null) {
  if (owner?.element === element) owner = undefined;
}
