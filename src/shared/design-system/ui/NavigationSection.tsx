import type { ReactNode } from "react";

export function NavigationSection({
  label,
  lang,
  action,
  children,
}: {
  label: string;
  /** Language of the label when it differs from the surrounding content. */
  lang?: string | undefined;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-buzz-ui="" className="navigation-section">
      <div className="navigation-section-heading">
        <h2
          lang={lang}
          className="navigation-section-label text-body text-secondary"
        >
          {label}
        </h2>
        {action}
      </div>
      <div className="navigation-section-rows">{children}</div>
    </section>
  );
}
