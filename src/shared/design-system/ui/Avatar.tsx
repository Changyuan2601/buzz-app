import "../styles/avatar-shape.css";
import "../styles/avatar-status.css";
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { useEffect, useState, type ReactNode } from "react";

type AvatarSize = "compact" | "small" | "default" | "large" | "fill";
type ImageStatus = "loading" | "loaded" | "failed";

function AvatarArtwork({
  src,
  fallback,
}: {
  src: string;
  fallback: ReactNode;
}) {
  const [status, setStatus] = useState<ImageStatus>("loading");
  const [showFallback, setShowFallback] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShowFallback(true), 150);
    return () => window.clearTimeout(timer);
  }, []);
  if (status === "failed") return <span aria-hidden="true">{fallback}</span>;
  return (
    <>
      <img
        src={src}
        data-loaded={status === "loaded" ? "true" : undefined}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("failed")}
      />
      {status === "loading" && showFallback ? (
        <span aria-hidden="true">{fallback}</span>
      ) : null}
    </>
  );
}

export function Avatar({
  src,
  alt,
  fallback,
  fallbackContent,
  size = "default",
  shape = "circle",
  statusBadge,
}: {
  src?: string | null | undefined;
  alt: string;
  fallback: string;
  fallbackContent?: ReactNode;
  size?: AvatarSize;
  shape?: "circle" | "squircle";
  statusBadge?: "online" | "away" | "offline" | undefined;
}) {
  const initial = Array.from(fallback.trim())[0]?.toUpperCase() || "?";
  const content = fallbackContent ?? initial;
  return (
    <span
      className="buzz-avatar-status"
      data-size={size}
      data-shape={shape}
      data-status={statusBadge}
    >
      <BaseAvatar.Root
        data-buzz-ui=""
        className="buzz-avatar"
        data-size={size}
        data-avatar-shape={shape}
        role={alt ? "img" : undefined}
        aria-label={
          alt ? `${alt}${statusBadge ? `, ${statusBadge}` : ""}` : undefined
        }
        aria-hidden={!alt || undefined}
      >
        {src ? (
          <AvatarArtwork key={src} src={src} fallback={content} />
        ) : (
          <span aria-hidden="true">{content}</span>
        )}
      </BaseAvatar.Root>
      {statusBadge && (
        <span className="buzz-avatar-status-dot" aria-hidden="true" />
      )}
    </span>
  );
}
