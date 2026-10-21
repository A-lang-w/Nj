interface LoadingIndicatorProps {
  /** Optional accessible label; defaults to "Loading" */
  label?: string;
  /** Additional class names for the outer container */
  className?: string;
}

/**
 * Shared loading indicator with a CSS-only spinner animation.
 * Uses project-neutral slate tones so it fits any page theme.
 */
export function LoadingIndicator({
  label = "Loading",
  className = "",
}: LoadingIndicatorProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className={`flex flex-col items-center justify-center gap-3 py-20 ${className}`}
    >
      <span className="block h-8 w-8 animate-spin rounded-full border-[3px] border-slate-200 border-t-slate-500 dark:border-slate-700 dark:border-t-slate-400" />
      <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}…
      </span>
    </div>
  );
}
