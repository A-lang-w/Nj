import { useEffect, useRef, useState } from "react";
import FocusTrap from "focus-trap-react";
import { useUiStore } from "@/stores/ui-store";
import { apiGet, apiPost, apiDelete } from "@/lib/api-client";
import type { Skill } from "@/types/api";
import { Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";
import { EmptyState } from "@/components/ui/EmptyState";
import { COLORS } from "@/lib/theme-colors";

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const requestIdRef = useRef(0);

  useEffect(() => {
    void loadSkills();
  }, [activeWorkspaceId]);

  const loadSkills = async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setDeleteError(null);
    try {
      const data = await apiGet<Skill[]>("/skills", {
        workspaceId: activeWorkspaceId,
      });
      if (requestIdRef.current !== requestId) return;
      setSkills(data);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setSkills([]);
      setLoadError(
        err instanceof Error ? err.message : "Failed to load skills",
      );
    } finally {
      if (requestIdRef.current === requestId) setIsLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiDelete(`/skills/${id}`);
      setDeleteError(null);
      setSkills((s) => s.filter((sk) => sk.id !== id));
    } catch (err) {
      // The item stays in the list with its Delete button, so the alert
      // below plus a second press is the full announce-and-retry path.
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete skill",
      );
    }
  };

  const filtered = skills.filter(
    (s) =>
      !searchTerm || s.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

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
        <div>
          <h1
            className="text-xl font-bold"
            style={{ color: COLORS.textPrimary }}
          >
            Skills
          </h1>
          <p className="text-sm" style={{ color: COLORS.textSecondary }}>
            Building blocks that add specific capabilities to your agents and
            threads.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          aria-label="Create skill"
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
        >
          <Plus className="h-4 w-4" /> Create skill
        </button>
      </div>

      <div
        className="flex h-[48px] items-center gap-3 border-b px-6"
        style={{ borderColor: COLORS.border }}
      >
        <div className="relative flex-1 max-w-md">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            style={{ color: COLORS.textSecondary }}
          />
          <input
            type="text"
            placeholder="Search skills…"
            aria-label="Search skills"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            style={{
              borderColor: COLORS.border,
              backgroundColor: COLORS.inputBg,
              color: COLORS.textPrimary,
            }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {deleteError && (
          <p
            role="alert"
            className="mx-auto mb-4 max-w-3xl rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-center text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
          >
            Couldn&apos;t delete skill: {deleteError}
          </p>
        )}
        {isLoading ? (
          <LoadingIndicator label="Loading skills" />
        ) : loadError && filtered.length === 0 ? (
          <EmptyState
            alert
            icon={Sparkles}
            title="Couldn't load skills"
            description={loadError}
            action={
              <button
                onClick={loadSkills}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
              >
                Retry
              </button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={searchTerm ? "No matching skills" : "No skills yet"}
            description={
              searchTerm
                ? undefined
                : "Create a skill to teach agents reusable instructions"
            }
            action={
              searchTerm ? undefined : (
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700"
                >
                  Create skill
                </button>
              )
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((skill) => (
              <div
                key={skill.id}
                className="group rounded-lg border p-4 transition-colors hover:border-primary-300 dark:hover:border-primary-700"
                style={{
                  borderColor: COLORS.border,
                  backgroundColor: COLORS.inputBg,
                }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100 text-primary-600 dark:bg-primary-900 dark:text-primary-300">
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <div>
                      <h2
                        className="font-medium"
                        style={{ color: COLORS.textPrimary }}
                      >
                        {skill.name}
                      </h2>
                      <span
                        className="text-xs"
                        style={{ color: COLORS.textSecondary }}
                      >
                        {skill.approvalStatus === "approved"
                          ? "Active"
                          : skill.approvalStatus}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(skill.id)}
                    aria-label={`Delete ${skill.name}`}
                    className="reveal-on-hover flex items-center justify-center rounded min-w-[44px] min-h-[44px] p-2.5 transition-opacity hover:text-red-500"
                    style={{ color: COLORS.textSecondary }}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
                {skill.description && (
                  <p
                    className="mt-3 text-sm line-clamp-2"
                    title={skill.description}
                    style={{ color: COLORS.textSecondary }}
                  >
                    {skill.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateSkillDialog
          workspaceId={activeWorkspaceId}
          onClose={() => setShowCreate(false)}
          onCreated={(skill) => {
            setSkills((prev) => [skill, ...prev]);
            setShowCreate(false);
          }}
        />
      )}
    </div>
  );
}

function CreateSkillDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: number;
  onClose: () => void;
  onCreated: (skill: Skill) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [triggers, setTriggers] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !instructions.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const triggerPatterns = triggers
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await apiPost<Skill>("/skills", {
        workspaceId,
        name: name.trim(),
        description: description.trim() || undefined,
        instructions: instructions.trim(),
        triggerPatterns,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FocusTrap
      active
      focusTrapOptions={{
        allowOutsideClick: true,
        escapeDeactivates: () => {
          onClose();
          return false;
        },
      }}
    >
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Create skill"
          className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              Create skill
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="rounded-lg p-3 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div>
              <label
                htmlFor="skill-name"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Name
              </label>
              <input
                id="skill-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </div>
            <div>
              <label
                htmlFor="skill-description"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Description
              </label>
              <input
                id="skill-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </div>
            <div>
              <label
                htmlFor="skill-instructions"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Instructions
              </label>
              <textarea
                id="skill-instructions"
                required
                rows={5}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </div>
            <div>
              <label
                htmlFor="skill-triggers"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Trigger patterns (one per line, optional)
              </label>
              <textarea
                id="skill-triggers"
                rows={3}
                value={triggers}
                onChange={(e) => setTriggers(e.target.value)}
                placeholder="review|code review"
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </div>
            {error && (
              <p
                role="alert"
                className="text-sm text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !name.trim() || !instructions.trim()}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 disabled:opacity-50"
              >
                {submitting ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </FocusTrap>
  );
}
