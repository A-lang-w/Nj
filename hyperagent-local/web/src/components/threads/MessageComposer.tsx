import { useState, useRef, useEffect, memo } from "react";
import { Send, Square, Paperclip, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import type { FileRecord } from "@/types/api";

interface MessageComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  /** When set, uploads are associated with this thread. */
  threadId?: number | null;
}

export const MessageComposer = memo(function MessageComposer({
  onSend,
  onStop,
  isStreaming,
  disabled,
  threadId,
}: MessageComposerProps) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<FileRecord[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [content]);

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded: FileRecord[] = [];
      for (const file of Array.from(fileList)) {
        const form = new FormData();
        form.append("file", file);
        form.append("workspaceId", String(activeWorkspaceId));
        if (threadId != null) {
          form.append("threadId", String(threadId));
        }
        const res = await fetch("/api/files", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Upload failed (${res.status})`);
        }
        uploaded.push((await res.json()) as FileRecord);
      }
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSubmit = () => {
    const trimmed = content.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    const attachmentNote =
      attachments.length > 0
        ? `\n\n[Attached files: ${attachments
            .map((f) => `${f.filename} (id=${f.id})`)
            .join(", ")}]`
        : "";
    onSend((trimmed || "Please review the attached files.") + attachmentNote);
    setContent("");
    setAttachments([]);
    setUploadError(null);
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

  const canSend =
    (content.trim().length > 0 || attachments.length > 0) && !disabled;

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
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2 border-t border-slate-100 px-3 py-2 dark:border-slate-800">
          {attachments.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <span className="max-w-[160px] truncate">{file.filename}</span>
              <button
                type="button"
                onClick={() =>
                  setAttachments((prev) => prev.filter((f) => f.id !== file.id))
                }
                className="rounded p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700"
                aria-label={`Remove ${file.filename}`}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploadError && (
        <p
          role="alert"
          className="border-t border-red-100 px-3 py-1.5 text-xs text-red-600 dark:border-red-900 dark:text-red-400"
        >
          {uploadError}
        </p>
      )}
      <div className="flex items-center justify-between border-t border-slate-100 px-2 py-1.5 dark:border-slate-800">
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            multiple
            onChange={(e) => void handleUpload(e.target.files)}
          />
          <button
            type="button"
            disabled={disabled || uploading}
            title={uploading ? "Uploading…" : "Add files"}
            aria-label={uploading ? "Uploading files" : "Add files"}
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <Paperclip className="h-4 w-4" aria-hidden="true" />
          </button>
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
            disabled={!canSend}
            className={cn(
              "flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-lg px-4 py-3 text-xs font-medium transition-colors",
              canSend
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
