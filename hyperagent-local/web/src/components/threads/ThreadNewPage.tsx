import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useThreadsStore } from "@/stores/threads-store";
import { useAgentsStore } from "@/stores/agents-store";
import { useUiStore } from "@/stores/ui-store";
import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { MessageComposer } from "./MessageComposer";
import { Sparkles, Bot } from "lucide-react";
import { useEffect } from "react";
import type { Agent } from "@/types/api";
import { COLORS } from "@/lib/theme-colors";

function AgentPicker({
  agents,
  selectedAgentId,
  onSelect,
}: {
  agents: Agent[];
  selectedAgentId: number | null;
  onSelect: (id: number | null) => void;
}) {
  if (agents.length === 0) return null;
  const optionStyle = (selected: boolean): React.CSSProperties => ({
    borderColor: selected ? COLORS.textPrimary : COLORS.border,
    backgroundColor: selected ? COLORS.activeBg : "transparent",
    color: selected ? COLORS.textPrimary : COLORS.textSecondary,
  });
  return (
    <div
      role="radiogroup"
      aria-label="Select an agent"
      className="flex flex-wrap gap-2"
    >
      <button
        role="radio"
        aria-checked={selectedAgentId === null}
        onClick={() => onSelect(null)}
        className="rounded-full border px-3 py-1.5 text-sm transition-colors"
        style={optionStyle(selectedAgentId === null)}
      >
        General
      </button>
      {agents.map((agent) => (
        <button
          key={agent.id}
          role="radio"
          aria-checked={selectedAgentId === agent.id}
          onClick={() => onSelect(agent.id)}
          className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors"
          style={optionStyle(selectedAgentId === agent.id)}
        >
          <Bot className="h-3 w-3" />
          {agent.name}
        </button>
      ))}
    </div>
  );
}

export function ThreadNewPage() {
  const navigate = useNavigate();
  const createThread = useThreadsStore((s) => s.createThread);
  const sendMessage = useThreadsStore((s) => s.sendMessage);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [orphanedThreadId, setOrphanedThreadId] = useState<number | null>(null);
  // The composer clears on submit, so a failed create/send must keep the
  // text here for Resend — otherwise the draft is silently lost.
  const [failedDraft, setFailedDraft] = useState<string | null>(null);
  const { isSubmitting, runGuarded } = useSubmitGuard();

  useEffect(() => {
    fetchAgents(activeWorkspaceId);
  }, [fetchAgents, activeWorkspaceId]);

  const handleSend = (content: string) =>
    runGuarded(async () => {
      setSendError(null);
      setOrphanedThreadId(null);
      setFailedDraft(null);
      let thread;
      try {
        thread = await createThread(
          activeWorkspaceId,
          selectedAgentId,
          content.slice(0, 50),
        );
      } catch (err) {
        setSendError(
          err instanceof Error ? err.message : "Failed to create thread",
        );
        setFailedDraft(content);
        return;
      }
      try {
        await sendMessage(thread.id, content);
      } catch (err) {
        // The thread exists but the message did not send: stay here with an
        // error and a way to reach the thread, not a silent dead end.
        setSendError(
          err instanceof Error ? err.message : "Failed to send message",
        );
        setOrphanedThreadId(thread.id);
        setFailedDraft(content);
        return;
      }
      // The first message is persisted but no assistant reply starts on its
      // own: tell the detail page to autostart the stream once loaded.
      navigate(`/threads/${thread.id}`, {
        replace: true,
        state: { autostart: true },
      });
    });

  const handleResend = () => {
    if (failedDraft === null) return Promise.resolve();
    if (orphanedThreadId !== null) {
      // The thread already exists: retry only the failed send, then enter
      // it — re-running the full flow would litter another empty thread.
      return runGuarded(async () => {
        setSendError(null);
        try {
          await sendMessage(orphanedThreadId, failedDraft);
        } catch (err) {
          setSendError(
            err instanceof Error ? err.message : "Failed to send message",
          );
          return;
        }
        setFailedDraft(null);
        navigate(`/threads/${orphanedThreadId}`, {
          replace: true,
          state: { autostart: true },
        });
      });
    }
    return handleSend(failedDraft);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header — consistent with other pages */}
      <div
        className="flex flex-col gap-4 border-b px-6 py-4 md:flex-row md:items-center md:justify-between"
        style={{
          borderColor: COLORS.border,
          height: "104px",
          boxSizing: "border-box",
        }}
      >
        <h1 className="text-xl font-bold" style={{ color: COLORS.textPrimary }}>
          New thread
        </h1>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div
          className="mb-8 flex h-16 w-16 items-center justify-center rounded-2xl"
          style={{
            backgroundColor: COLORS.avatarBg,
            color: COLORS.textPrimary,
          }}
        >
          <Sparkles className="h-8 w-8" />
        </div>
        <h2
          className="mb-2 text-3xl font-bold"
          style={{ color: COLORS.textPrimary }}
        >
          Let's get to work.
        </h2>
        <p className="mb-8" style={{ color: COLORS.textSecondary }}>
          Ask anything or start a task with your agents.
        </p>

        <div className="w-full max-w-2xl space-y-4">
          <AgentPicker
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSelect={setSelectedAgentId}
          />

          {sendError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
              style={{
                borderColor: "rgb(185, 28, 28)",
                backgroundColor: "rgba(185, 28, 28, 0.15)",
                color: "rgb(252, 165, 165)",
              }}
            >
              <span>
                {sendError}
                {orphanedThreadId !== null && (
                  <>
                    {" "}
                    <Link
                      to={`/threads/${orphanedThreadId}`}
                      className="font-medium underline"
                    >
                      Open the empty thread
                    </Link>
                  </>
                )}
              </span>
              <button
                onClick={() => {
                  void handleResend();
                }}
                disabled={failedDraft === null || isSubmitting}
                className="shrink-0 rounded-md px-3 py-1 text-xs font-medium disabled:opacity-50"
                style={{
                  backgroundColor: "rgb(220, 38, 38)",
                  color: "rgb(255, 255, 255)",
                }}
              >
                Resend
              </button>
            </div>
          )}
          <MessageComposer
            onSend={handleSend}
            onStop={() => {}}
            isStreaming={false}
            disabled={isSubmitting}
            agents={agents}
            selectedAgentId={selectedAgentId}
            onAgentChange={setSelectedAgentId}
          />
        </div>
      </div>
    </div>
  );
}
