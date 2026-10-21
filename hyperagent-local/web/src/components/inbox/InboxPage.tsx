import { useEffect } from "react";
import { useInboxStore } from "@/stores/inbox-store";
import { useUiStore } from "@/stores/ui-store";
import { Inbox, Bell, MessageSquare, Bot, Sparkles, Star } from "lucide-react";
import { Link } from "react-router-dom";
import { formatDate } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { COLORS } from "@/lib/theme-colors";

const EVENT_ICONS: Record<string, React.ElementType> = {
  "thread.created": MessageSquare,
  "thread.updated": MessageSquare,
  "thread.deleted": MessageSquare,
  "message.done": MessageSquare,
  "memory.created": Sparkles,
  "memory.updated": Sparkles,
  "memory.deleted": Sparkles,
  "skill.created": Sparkles,
  "skill.updated": Sparkles,
  "skill.deleted": Sparkles,
  "agent.created": Bot,
  "agent.updated": Bot,
  "agent.deleted": Bot,
  "mcp_server.created": Bot,
  "mcp_server.updated": Bot,
  "mcp_server.deleted": Bot,
  "favorite.added": Star,
  "favorite.removed": Star,
};

function activityHref(event: {
  eventType: string;
  targetType: string | null;
  targetId: number | null;
}): string | null {
  if (event.targetId == null) return null;
  switch (event.targetType) {
    case "thread":
      return `/threads/${event.targetId}`;
    case "agent":
      return "/agents";
    case "skill":
      return "/skills";
    case "memory":
      return "/memories";
    case "mcp_server":
      return "/settings";
    default:
      if (event.eventType.startsWith("thread.")) {
        return `/threads/${event.targetId}`;
      }
      return null;
  }
}

export function InboxPage() {
  const summary = useInboxStore((s) => s.summary);
  const activity = useInboxStore((s) => s.activity);
  const fetchSummary = useInboxStore((s) => s.fetchSummary);
  const fetchActivity = useInboxStore((s) => s.fetchActivity);
  const isLoading = useInboxStore((s) => s.isLoading);
  const fetchError = useInboxStore((s) => s.fetchError);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    fetchSummary();
    fetchActivity();
  }, [fetchSummary, fetchActivity, activeWorkspaceId]);

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center justify-between border-b px-6 py-4"
        style={{
          borderColor: COLORS.border,
          height: "104px",
          boxSizing: "border-box",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg"
            style={{
              backgroundColor: COLORS.avatarBg,
              color: COLORS.textPrimary,
            }}
          >
            <Inbox className="h-5 w-5" />
          </div>
          <div>
            <h1
              className="text-xl font-bold"
              style={{ color: COLORS.textPrimary }}
            >
              Inbox
            </h1>
            <p
              className="text-sm"
              style={{ color: COLORS.textSecondary }}
              aria-live="polite"
              aria-atomic="true"
            >
              {summary?.activeThreadCount ?? 0} active threads
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <LoadingIndicator label="Loading inbox" />
        ) : fetchError && activity.length === 0 ? (
          <EmptyState
            alert
            icon={Inbox}
            title="Couldn't load inbox"
            description={fetchError}
            action={
              <button
                onClick={() => {
                  fetchSummary();
                  fetchActivity();
                }}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
              >
                Retry
              </button>
            }
          />
        ) : activity.length === 0 ? (
          <EmptyState icon={Bell} title="No recent activity" />
        ) : (
          <ul role="list" className="mx-auto max-w-2xl space-y-2">
            {activity.map((event) => {
              const Icon = EVENT_ICONS[event.eventType] || Bell;
              const href = activityHref(event);
              const body = (
                <>
                  <div
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
                    style={{
                      backgroundColor: COLORS.avatarBg,
                      color: COLORS.textSecondary,
                    }}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-sm font-medium"
                      style={{ color: COLORS.textPrimary }}
                    >
                      {event.eventType.replace(/\./g, " ").replace(/_/g, " ")}
                    </p>
                    <p
                      className="text-xs"
                      style={{ color: COLORS.textSecondary }}
                    >
                      {formatDate(event.createdAt)}
                    </p>
                  </div>
                </>
              );
              return (
                <li key={event.id}>
                  {href ? (
                    <Link
                      to={href}
                      className="flex items-start gap-3 rounded-lg border p-4 transition-colors hover:border-primary-300 dark:hover:border-primary-700"
                      style={{
                        borderColor: COLORS.border,
                        backgroundColor: COLORS.bg,
                      }}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div
                      className="flex items-start gap-3 rounded-lg border p-4"
                      style={{
                        borderColor: COLORS.border,
                        backgroundColor: COLORS.bg,
                      }}
                    >
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
