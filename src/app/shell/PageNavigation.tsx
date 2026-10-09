import type { RegisteredPage } from "../../features/pages/service";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PageIcon } from "./PageIcon";
import { pagePresentation } from "./presentation";

export function PageNavigation({
  pages,
  selected,
  onSelect,
  placement = "sidebar",
}: {
  pages: readonly RegisteredPage[];
  selected: string;
  onSelect(key: string): void;
  placement?: "sidebar" | "topbar" | "toolbar";
}) {
  return pages.map((page) => {
    const { label, icon, image } = pagePresentation(page);
    const Badge = page.badge;
    const badge = Badge && (
      <ContributionBoundary key={contributionKey(page)} fallback={null}>
        <Badge />
      </ContributionBoundary>
    );
    const select = () => {
      onSelect(page.key);
      document.getElementById("main-content")?.focus({ preventScroll: true });
    };
    const pageIcon = (
      <PageIcon
        key={page.key}
        icon={icon}
        image={image}
        size={16}
        strokeWidth={2.5}
      />
    );
    return placement === "toolbar" ? (
      <span className="shell-toolbar-page" key={page.key}>
        <IconButton
          aria-label={label}
          title={label}
          variant="chrome"
          aria-current={selected === page.key ? "page" : undefined}
          onClick={select}
          icon={pageIcon}
        />
        {badge && <span className="shell-toolbar-badge">{badge}</span>}
      </span>
    ) : (
      <NavigationItem
        key={page.key}
        onClick={select}
        selected={selected === page.key}
        label={label}
        title={label}
        variant={placement === "topbar" ? "pill" : "row"}
        trailing={badge}
        icon={
          placement === "sidebar" ? (
            <span className="shell-page-icon">{pageIcon}</span>
          ) : undefined
        }
      />
    );
  });
}
