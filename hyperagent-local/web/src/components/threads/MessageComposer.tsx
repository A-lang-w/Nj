import { useState, useRef, useEffect, memo } from "react";
import { Send, Square, Paperclip, Settings, Bot, Mic } from "lucide-react";
import { cn } from "@/lib/utils";

interface MessageComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

const COMING_SOON_ACTIONS = [
  { label: "Add files", Icon: Paperclip },
  { label: "Thread settings", Icon: Settings },
  { label: "Use an agent", Icon: Bot },
  { label: "Dictate", Icon: Mic },
] as const;

export const MessageComposer = memo(function MessageComposer({
  onSend,
  onStop,
  isStreaming,
  disabled,
}: MessageComposerProps) {
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [content]);

  const handleSubmit = () => {
    const trimmed = content.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setContent("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return;
      handleSubmit();
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      {/* Visually hidden label preserves chat-input aesthetics while providing a structural label for assistive tech; aria-label retained as fallback. */}
      <label htmlFor="message-composer" className="sr-only">
        Message the assistant
      </label>
      <textarea
        id="message-composer"
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask anything or start a task…"
        aria-label="Message the assistant"
        disabled={disabled}
        rows={1}
        className="w-full resize-none bg-transparent px-4 py-3 text-sm text-slate-900 placeholder:text-slate-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:text-white dark:placeholder:text-slate-400"
      />
      <div className="flex items-center justify-between border-t border-slate-100 px-2 py-1.5 dark:border-slate-800">
        <div className="flex items-center gap-1">
          {COMING_SOON_ACTIONS.map(({ label, Icon }) => (
            <button
              key={label}
              type="button"
              disabled
              title={`${label} — coming soon`}
              aria-label={`${label} — coming soon`}
              className="cursor-not-allowed rounded-lg p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-500 opacity-50 dark:text-slate-400"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
          ))}
        </div>
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-lg bg-red-600 px-4 py-3 text-xs font-medium text-white hover:bg-red-700"
          >
            <Square className="h-3 w-3 fill-current" /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!content.trim() || disabled}
            className={cn(
              "flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-lg px-4 py-3 text-xs font-medium transition-colors",
              content.trim() && !disabled
                ? "bg-primary-600 text-primary-950 hover:bg-primary-700"
                : "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500",
            )}
          >
            <Send className="h-3 w-3" /> Send
          </button>
        )}
      </div>
    </div>
  );
});
