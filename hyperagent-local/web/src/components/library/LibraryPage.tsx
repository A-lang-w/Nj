import { useEffect, useRef, useState } from "react";
import { useUiStore } from "@/stores/ui-store";
import { apiGet, apiDelete } from "@/lib/api-client";
import type { FileRecord } from "@/types/api";
import { Library, Trash2, Download, Upload } from "lucide-react";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { EmptyState } from "@/components/ui/EmptyState";
import { COLORS } from "@/lib/theme-colors";

export function LibraryPage() {
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

  const load = async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiGet<FileRecord[]>("/files", {
        workspaceId: activeWorkspaceId,
      });
      if (requestIdRef.current !== requestId) return;
      setFiles(data);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setFiles([]);
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      if (requestIdRef.current === requestId) setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [activeWorkspaceId]);

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(fileList)) {
        const form = new FormData();
        form.append("file", file);
        form.append("workspaceId", String(activeWorkspaceId));
        const res = await fetch("/api/files", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Upload failed (${res.status})`);
        }
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm("Delete this file?")) return;
    try {
      await apiDelete(`/files/${id}`);
      setFiles((prev) => prev.filter((f) => f.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete file");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center justify-between border-b px-6 py-4"
        style={{
          borderColor: COLORS.border,
          height: 104,
          boxSizing: "border-box",
        }}
      >
        <div>
          <h1
            className="text-xl font-bold"
            style={{ color: COLORS.textPrimary }}
          >
            Library
          </h1>
          <p className="text-sm" style={{ color: COLORS.textSecondary }}>
            Local files for this workspace
          </p>
        </div>
        <div>
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            multiple
            onChange={(e) => void handleUpload(e.target.files)}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-primary-950 disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <p
            role="alert"
            className="mb-4 text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
        {isLoading ? (
          <LoadingIndicator label="Loading files" />
        ) : files.length === 0 ? (
          <EmptyState
            icon={Library}
            title="No files yet"
            description="Upload documents or attachments to keep them local"
            action={
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950"
              >
                Upload a file
              </button>
            }
          />
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <p
                    className="truncate font-medium"
                    style={{ color: COLORS.textPrimary }}
                  >
                    {file.filename}
                  </p>
                  <p
                    className="text-xs"
                    style={{ color: COLORS.textSecondary }}
                  >
                    {file.mimeType} · {(file.sizeBytes / 1024).toFixed(1)} KB
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <a
                    href={`/api/files/${file.id}/content`}
                    download={file.filename}
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                    aria-label={`Download ${file.filename}`}
                  >
                    <Download className="h-4 w-4" />
                  </a>
                  <button
                    type="button"
                    onClick={() => void handleDelete(file.id)}
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-slate-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                    aria-label={`Delete ${file.filename}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
