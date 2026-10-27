import { useEffect, useState, type ReactNode } from "react";

/** Delay feedback, never content. The caller supplies the stable content geometry. */
export function LoadingRegion({
  pending,
  label,
  children,
  feedback,
}: {
  pending: boolean;
  label: ReactNode;
  children: ReactNode;
  /** Immediate scoped error/retry; replaces only the reserved feedback slot. */
  feedback?: ReactNode;
}) {
  const [announced, setAnnounced] = useState(false);
  useEffect(() => {
    setAnnounced(false);
    if (!pending) return;
    const timer = setTimeout(() => setAnnounced(true), 1000);
    return () => clearTimeout(timer);
  }, [pending]);
  return (
    <div data-buzz-ui="" className="buzz-loading-region" aria-busy={pending}>
      <div className="buzz-loading-region-feedback">
        {feedback ?? (
          <p
            className="buzz-loading-region-status"
            role={pending && announced ? "status" : undefined}
          >
            {pending && announced ? label : ""}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
