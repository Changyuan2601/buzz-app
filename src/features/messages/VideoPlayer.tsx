import { useVideoGestures } from "./use-video-gestures";
import { useMediaControls } from "./use-media-controls";
import { useMediaCorners } from "./use-media-corners";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  PauseFilledIcon,
  PlayFilledIcon,
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
} from "../../shared/design-system/icons";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { formatMediaTime } from "./media-timecode";
import styles from "./VideoPlayer.module.css";
import { useMediaElementSource } from "./use-media-element-source";
import { MediaDownloadAction } from "./MediaDownloadAction";

export type VideoMarker = {
  id: string;
  seconds: number;
  label: string;
  author: string;
  picture?: string | undefined;
  text: string;
};
const speeds = [2, 1.75, 1.5, 1.25, 1, 0.75, 0.5, 0.25];
const speedKey = "buzz.video.playback-speed";
const speedEvent = "buzz:video-playback-speed";
function savedSpeed() {
  try {
    const value = Number(localStorage.getItem(speedKey));
    return speeds.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}
export function videoTime(seconds: number) {
  return formatMediaTime(seconds).padStart(5, "0");
}

/** The same controls serve chat previews and review; the caller owns the video. */
export function VideoControls({
  videoRef,
  inline = false,
  markers = [],
  onMarker,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  inline?: boolean;
  markers?: readonly VideoMarker[];
  onMarker?(id: string, seconds: number): void;
}) {
  const corners = useMediaCorners();
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [volumeMotion, setVolumeMotion] = useState(false);
  const audibleVolume = muted ? 0 : volume;
  const [rate, setRate] = useState(savedSpeed);
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const play = () => {
      setPlaying(true);
      setNotice(undefined);
    };
    const pause = () => setPlaying(false);
    const metadata = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    };
    const sound = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const speed = () => setRate(video.playbackRate);
    const restoreSpeed = () => {
      video.playbackRate = savedSpeed();
      speed();
    };
    const receiveSpeed = (event: Event) => {
      video.playbackRate = (event as CustomEvent<number>).detail;
      speed();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === speedKey || event.key === null) restoreSpeed();
    };
    restoreSpeed();
    window.addEventListener(speedEvent, receiveSpeed);
    window.addEventListener("storage", storage);
    const events = {
      play,
      pause,
      ended: pause,
      durationchange: metadata,
      loadedmetadata: metadata,
      volumechange: sound,
      ratechange: speed,
    };
    for (const [event, listener] of Object.entries(events))
      video.addEventListener(event, listener);
    metadata();
    sound();
    speed();
    if (!video.paused) play();
    return () => {
      window.removeEventListener(speedEvent, receiveSpeed);
      window.removeEventListener("storage", storage);
      for (const [event, listener] of Object.entries(events))
        video.removeEventListener(event, listener);
    };
  }, [videoRef]);
  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) video.pause();
    else
      void video
        .play()
        .catch(() => setNotice("Playback paused. Press play to try again."));
  };
  const seek = (seconds: number) => {
    if (!videoRef.current || !duration) return;
    const next = Math.max(0, Math.min(seconds, duration));
    videoRef.current.currentTime = next;
    // Keep authoring time and inline handoff synchronized even while paused.
    videoRef.current.dispatchEvent(new Event("timeupdate"));
  };
  const playButton = (
    <span className={inline ? styles.center : styles.play}>
      <IconButton
        size={inline ? "md" : "sm"}
        variant={inline ? "media" : "ghost"}
        aria-label={playing ? "Pause video" : "Play video"}
        onClick={toggle}
        icon={playing ? <PauseFilledIcon /> : <PlayFilledIcon />}
      />
    </span>
  );
  return (
    <>
      {inline && playButton}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <div
        ref={inline ? corners : undefined}
        className={styles.controls}
        data-video-controls=""
        data-inline={inline || undefined}
        data-playing={playing || undefined}
        data-review-chrome={inline ? undefined : ""}
      >
        {!inline && playButton}
        <PopoverRoot>
          <PopoverTrigger
            openOnHover="control"
            render={
              <IconButton
                size="sm"
                aria-label="Video volume"
                icon={
                  muted || volume === 0 ? (
                    <SpeakerSlashIcon />
                  ) : (
                    <SpeakerHighIcon />
                  )
                }
              />
            }
          />
          <PopoverPopup
            aria-label="Video volume controls"
            collisionAvoidance={{ side: "none", align: "shift" }}
            side="top"
            align="center"
            sideOffset={8}
            size="compact"
            padding="list"
            colorMode="dark"
            initialFocus={(type) => type === "keyboard"}
            render={<div className={styles.volumePopup} />}
          >
            <div
              className={styles.volumeSlider}
              data-volume-motion={volumeMotion || undefined}
            >
              <div className={styles.volumeTrack} aria-hidden="true">
                <span
                  className={styles.volumeFill}
                  style={{ transform: `scaleY(${audibleVolume})` }}
                />
                <span
                  className={styles.volumeKnob}
                  style={{ transform: `translateY(${-audibleVolume * 100}%)` }}
                />
              </div>
              <input
                type="range"
                tabIndex={0}
                aria-label="Video volume"
                aria-orientation="vertical"
                min={0}
                max={1}
                step={0.05}
                value={
                  // Native media can report float32 noise beyond the .05 step's precision.
                  Number(audibleVolume.toFixed(2))
                }
                onChange={(event) => {
                  if (!videoRef.current) return;
                  setVolumeMotion(false);
                  videoRef.current.volume = Number(event.currentTarget.value);
                  videoRef.current.muted = false;
                }}
              />
            </div>
            <IconButton
              size="sm"
              aria-label={muted || volume === 0 ? "Unmute video" : "Mute video"}
              onClick={(event) => {
                const video = videoRef.current;
                if (!video) return;
                setVolumeMotion(event.detail > 0);
                video.muted = !(muted || volume === 0);
                if (!video.muted && video.volume === 0) video.volume = 1;
              }}
              icon={
                muted || volume === 0 ? (
                  <SpeakerSlashIcon />
                ) : (
                  <SpeakerHighIcon />
                )
              }
            />
          </PopoverPopup>
        </PopoverRoot>
        <VideoTimeline
          videoRef={videoRef}
          inline={inline}
          duration={duration}
          seek={seek}
        >
          {duration > 0 &&
            markers
              .filter((marker) => marker.seconds <= duration)
              .map((marker) => (
                <span
                  key={marker.id}
                  className={styles.marker}
                  style={{ left: `${(marker.seconds / duration) * 100}%` }}
                >
                  <IconButton
                    size="sm"
                    variant="avatar"
                    aria-label={`Seek to ${marker.label}, ${marker.author}`}
                    title={`${marker.label} · ${marker.author}: ${marker.text}`}
                    onClick={() => {
                      seek(marker.seconds);
                      onMarker?.(marker.id, marker.seconds);
                    }}
                    icon={
                      <Avatar
                        size="fill"
                        src={marker.picture}
                        alt=""
                        fallback={marker.author}
                      />
                    }
                  />
                </span>
              ))}
        </VideoTimeline>
        <span className={`${styles.time} ${styles.duration}`}>
          {videoTime(duration)}
        </span>
        <div className={styles.speed}>
          <MenuRoot modal={false}>
            <MenuTrigger
              openOnHover="control"
              render={
                <Button variant="ghost" size="sm">
                  {rate}x
                </Button>
              }
              aria-label={`Playback speed: ${rate}x`}
            >
              {rate}x
            </MenuTrigger>
            <MenuPopup
              side="top"
              align="center"
              sideOffset={8}
              size="compact"
              render={
                <div
                  className={`${styles.speedPopup} dark`}
                  data-color-mode="dark"
                />
              }
            >
              <MenuRadioGroup
                value={String(rate)}
                onValueChange={(value) => {
                  const speed = Number(value);
                  if (videoRef.current) videoRef.current.playbackRate = speed;
                  setRate(speed);
                  try {
                    localStorage.setItem(speedKey, String(speed));
                  } catch {
                    /* Playback works without storage. */
                  }
                  window.dispatchEvent(
                    new CustomEvent(speedEvent, { detail: speed }),
                  );
                }}
              >
                {speeds.map((speed) => (
                  <MenuRadioItem key={speed} value={String(speed)} closeOnClick>
                    {speed}x
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </MenuRoot>
        </div>
      </div>
    </>
  );
}

/**
 * The playing position follows every frame. Only this part of the controls
 * re-renders for it; markers arrive as children and keep their elements.
 */
function VideoTimeline({
  videoRef,
  inline,
  duration,
  seek,
  children,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  inline: boolean;
  duration: number;
  seek(seconds: number): void;
  children: ReactNode;
}) {
  const [time, setTime] = useState(0);
  const [hover, setHover] = useState<number>();
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let frame = 0;
    let step = -1;
    // Offscreen controls follow timeupdate; per-frame progress only matters
    // where it can be seen. Without IntersectionObserver, always tick.
    let onscreen = typeof IntersectionObserver === "undefined";
    // The fill moves every frame, but the text (whole seconds) and the
    // slider's 0.1s steps change only on a 0.05s boundary. Paint the fill
    // directly and render only when a boundary is crossed.
    const paint = () => {
      const seconds = video.currentTime;
      const total = Number.isFinite(video.duration) ? video.duration : 0;
      slider.current?.style.setProperty(
        "--progress",
        `${total ? (seconds / total) * 100 : 0}%`,
      );
      return seconds;
    };
    const syncTime = () => {
      const seconds = paint();
      step = Math.floor(seconds * 20);
      setTime(seconds);
    };
    const tick = () => {
      const seconds = paint();
      if (Math.floor(seconds * 20) !== step) {
        step = Math.floor(seconds * 20);
        setTime(seconds);
      }
      frame = requestAnimationFrame(tick);
    };
    const play = () => {
      cancelAnimationFrame(frame);
      if (onscreen) frame = requestAnimationFrame(tick);
    };
    const observer = onscreen
      ? undefined
      : new IntersectionObserver((entries) => {
          onscreen = !!entries.at(-1)?.isIntersecting;
          cancelAnimationFrame(frame);
          if (!onscreen || video.paused) return;
          syncTime();
          frame = requestAnimationFrame(tick);
        });
    observer?.observe(video);
    const pause = () => {
      cancelAnimationFrame(frame);
      syncTime();
    };
    const events = {
      timeupdate: syncTime,
      seeked: syncTime,
      play,
      pause,
      ended: pause,
    };
    for (const [event, listener] of Object.entries(events))
      video.addEventListener(event, listener);
    syncTime();
    if (!video.paused) play();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      for (const [event, listener] of Object.entries(events))
        video.removeEventListener(event, listener);
    };
  }, [videoRef]);
  return (
    <>
      <span className={styles.time}>{videoTime(time)}</span>
      <div
        className={styles.timeline}
        onPointerMove={(event) => {
          if (event.pointerType !== "mouse") return;
          const bounds = event.currentTarget.getBoundingClientRect();
          setHover(
            Math.max(
              0,
              Math.min(
                1,
                (event.clientX - bounds.left - 1) /
                  Math.max(1, bounds.width - 2),
              ),
            ),
          );
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <input
          ref={slider}
          type="range"
          tabIndex={0}
          aria-label={inline ? "Video progress" : "Video timeline"}
          aria-valuetext={`${videoTime(time)} / ${videoTime(duration)}`}
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(time, duration)}
          disabled={!duration}
          style={
            {
              "--progress": `${duration ? (time / duration) * 100 : 0}%`,
            } as CSSProperties
          }
          onChange={(event) => seek(Number(event.currentTarget.value))}
        />
        {hover !== undefined && duration > 0 && (
          <span
            className={styles.seekPreview}
            style={{ left: `calc(1px + (100% - 2px) * ${hover})` }}
            aria-hidden="true"
            data-seek-preview=""
          >
            <span className={styles.hoverTime}>
              {videoTime(hover * duration)}
            </span>
          </span>
        )}
        {children}
      </div>
    </>
  );
}

export function VideoPlayer({
  source,
  downloadName,
  poster,
  videoRef,
  initialTime = 0,
  onTime,
  onError,
  markers,
  onMarker,
  children,
}: {
  source: string;
  /** Supplied only by received-attachment owners, never unsent previews. */
  downloadName?: string | undefined;
  poster?: string | undefined;
  videoRef: RefObject<HTMLVideoElement | null>;
  initialTime?: number;
  onTime(seconds: number): void;
  onError(): void;
  markers?: readonly VideoMarker[];
  onMarker?(id: string, seconds: number): void;
  children?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [downloadFeedback, setDownloadFeedback] = useState(false);
  const idle = useMediaControls(stage, source, downloadFeedback);
  const { handlers: gestures, feedback } = useVideoGestures(videoRef, source);
  // Callers render their unavailable state instead of a player when
  // `useMediaElementSource(source).unavailable`.
  const { src: elementSource } = useMediaElementSource(source);
  return (
    <div
      ref={stage}
      className={`${styles.player} dark`}
      data-color-mode="dark"
      data-controls-idle={idle || undefined}
      data-controls-revealed={downloadFeedback || undefined}
    >
      <video
        ref={videoRef}
        {...gestures}
        data-review-media=""
        src={elementSource}
        poster={poster}
        playsInline
        autoPlay
        preload="auto"
        onPlay={(event) => {
          // A pending play request can settle after dismissal has begun.
          if (event.currentTarget.closest("[data-review-closing]"))
            event.currentTarget.pause();
        }}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          element.currentTime = Math.max(
            0,
            Math.min(
              initialTime,
              Number.isFinite(element.duration)
                ? element.duration
                : initialTime,
            ),
          );
          onTime(element.currentTime);
        }}
        onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)}
        onError={onError}
      />
      {feedback && (
        <div
          key={feedback.id}
          className={`${styles.center} ${styles.gestureFeedback}`}
          data-video-feedback={feedback.kind}
          data-review-chrome=""
          aria-hidden="true"
        >
          {feedback.kind === "play" ? (
            <PlayFilledIcon size={24} />
          ) : feedback.kind === "pause" ? (
            <PauseFilledIcon size={24} />
          ) : feedback.kind === "speed" ? (
            <span>2×</span>
          ) : (
            <>
              {feedback.kind === "forward" ? (
                <ArrowClockwiseIcon size={36} />
              ) : (
                <ArrowCounterClockwiseIcon size={36} />
              )}
              <span className={styles.seekAmount}>10</span>
            </>
          )}
        </div>
      )}
      <div className={styles.reviewControls} data-review-chrome="">
        <VideoControls
          videoRef={videoRef}
          {...(markers ? { markers } : {})}
          {...(onMarker ? { onMarker } : {})}
        />
        {downloadName !== undefined && (
          <MediaDownloadAction
            source={source}
            name={downloadName}
            kind="video"
            onFeedbackVisible={setDownloadFeedback}
          />
        )}
        {children}
      </div>
    </div>
  );
}
