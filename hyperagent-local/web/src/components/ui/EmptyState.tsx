import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { COLORS } from "@/lib/theme-colors";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  /**
   * Semantic heading level for the title. Choose based on the surrounding
   * document outline so that heading levels do not skip (e.g., use `"h3"`
   * only when the page already contains an `<h2>`). Defaults to `"h2"`.
   *
   * When embedding this component inside a landmark or section that already
   * has its own heading, prefer wrapping that region in
   * `<section aria-labelledby="...">` and matching this prop to the section's
   * label rather than introducing a new top-level heading. If the empty state
   * is purely decorative and no heading should appear in the outline, keep
   * the default and ensure the parent landmark provides the accessible name.
   */
  headingLevel?: "h2" | "h3" | "h4";
  /** Set for load-failure states so assistive tech announces them; plain
   * empty states stay silent. */
  alert?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  headingLevel: Heading = "h2",
  alert = false,
}: EmptyStateProps) {
  return (
    <div
      role={alert ? "alert" : undefined}
      className="flex flex-col items-center justify-center py-20 text-center"
    >
      <div
        className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
        style={{
          backgroundColor: COLORS.avatarBg,
          color: COLORS.textSecondary,
        }}
      >
        <Icon className="h-8 w-8" aria-hidden="true" />
      </div>
      <Heading
        className="mb-1 text-sm font-medium"
        style={{ color: COLORS.textPrimary }}
      >
        {title}
      </Heading>
      {description && (
        <p className="max-w-xs text-sm" style={{ color: COLORS.textSecondary }}>
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
