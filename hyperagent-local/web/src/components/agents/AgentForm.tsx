import { useEffect, useState } from "react";
import FocusTrap from "focus-trap-react";
import { useAgentsStore } from "@/stores/agents-store";
import { useUiStore } from "@/stores/ui-store";
import type { Agent } from "@/types/api";
import { X } from "lucide-react";

interface AgentFormProps {
  onClose: () => void;
  /** When set, the dialog updates this agent instead of creating. */
  agent?: Agent;
}

export function AgentForm({ onClose, agent }: AgentFormProps) {
  const createAgent = useAgentsStore((s) => s.createAgent);
  const updateAgent = useAgentsStore((s) => s.updateAgent);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const isEdit = agent !== undefined;
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(
    agent?.systemPrompt ?? "You are a helpful assistant.",
  );
  const [model, setModel] = useState(agent?.model ?? "claude-opus-5-5");
  const [temperature, setTemperature] = useState(
    agent?.temperature != null ? String(agent.temperature) : "0.7",
  );
  const [maxTokens, setMaxTokens] = useState(
    agent?.maxTokens != null ? String(agent.maxTokens) : "4096",
  );
  const [toolsJsonText, setToolsJsonText] = useState(
    JSON.stringify(agent?.toolsJson ?? [], null, 2),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<{
    name?: string;
    systemPrompt?: string;
    tools?: string;
    temperature?: string;
    maxTokens?: string;
  }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      trigger?.focus();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: {
      name?: string;
      systemPrompt?: string;
      tools?: string;
      temperature?: string;
      maxTokens?: string;
    } = {};
    if (!name.trim()) newErrors.name = "Name is required.";
    if (!systemPrompt.trim())
      newErrors.systemPrompt = "System prompt is required.";
    let tools: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(toolsJsonText || "[]");
      if (!Array.isArray(parsed)) {
        newErrors.tools = "Tools must be a JSON array.";
      } else {
        tools = parsed;
      }
    } catch {
      newErrors.tools = "Tools must be valid JSON.";
    }
    const temperatureNum = Number(temperature);
    const maxTokensNum = Number(maxTokens);
    if (
      !Number.isFinite(temperatureNum) ||
      temperatureNum < 0 ||
      temperatureNum > 2
    ) {
      newErrors.temperature = "Temperature must be between 0 and 2.";
    }
    if (
      !Number.isInteger(maxTokensNum) ||
      maxTokensNum < 1 ||
      maxTokensNum > 1_000_000
    ) {
      newErrors.maxTokens = "Max tokens must be an integer from 1 to 1000000.";
    }
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        systemPrompt: systemPrompt.trim(),
        model,
        temperature: temperatureNum,
        maxTokens: maxTokensNum,
        tools,
      };
      if (isEdit && agent) {
        await updateAgent(
          agent.id,
          payload as Partial<Agent> & {
            tools: unknown[];
            temperature: number;
            maxTokens: number;
          },
        );
      } else {
        await createAgent({
          workspaceId: activeWorkspaceId,
          ...payload,
          description: description.trim() || undefined,
        } as Partial<Agent> & {
          tools: unknown[];
          temperature: number;
          maxTokens: number;
        });
      }
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : isEdit
            ? "Failed to update agent"
            : "Failed to create agent",
      );
    } finally {
      setIsSubmitting(false);
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
          aria-label={isEdit ? "Edit agent" : "New agent"}
          className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              {isEdit ? "Edit Agent" : "New Agent"}
            </h2>
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="rounded-lg p-3 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="agent-name"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Name
              </label>
              <input
                id="agent-name"
                type="text"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (errors.name)
                    setErrors((prev) => ({ ...prev, name: undefined }));
                }}
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? "agent-name-error" : undefined}
                className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:bg-slate-950 dark:text-white ${errors.name ? "border-red-500 focus:border-red-500 focus:ring-red-500" : "border-slate-300 dark:border-slate-700"}`}
                placeholder="e.g., Code Expert"
              />
              {errors.name && (
                <p
                  id="agent-name-error"
                  className="mt-1 text-xs text-red-600 dark:text-red-400"
                  role="alert"
                >
                  {errors.name}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="agent-description"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Description
              </label>
              <input
                id="agent-description"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                placeholder="Brief description of what this agent does"
              />
            </div>
            <div>
              <label
                htmlFor="agent-system-prompt"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                System Prompt
              </label>
              <textarea
                id="agent-system-prompt"
                required
                rows={4}
                value={systemPrompt}
                onChange={(e) => {
                  setSystemPrompt(e.target.value);
                  if (errors.systemPrompt)
                    setErrors((prev) => ({ ...prev, systemPrompt: undefined }));
                }}
                aria-invalid={!!errors.systemPrompt}
                aria-describedby={
                  errors.systemPrompt ? "agent-system-prompt-error" : undefined
                }
                className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:bg-slate-950 dark:text-white ${errors.systemPrompt ? "border-red-500 focus:border-red-500 focus:ring-red-500" : "border-slate-300 dark:border-slate-700"}`}
              />
              {errors.systemPrompt && (
                <p
                  id="agent-system-prompt-error"
                  className="mt-1 text-xs text-red-600 dark:text-red-400"
                  role="alert"
                >
                  {errors.systemPrompt}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="agent-model"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Model
              </label>
              <select
                id="agent-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              >
                <option value="claude-sonnet-5">Claude Sonnet 5</option>
                <option value="claude-opus-5-5">Claude Opus 5.5</option>
                <option value="claude-fable-5.1">Claude Fable 5.1</option>
                <option value="z-ai/glm-5.3">GLM 5.3</option>
                <option value="gpt-6-astra">GPT-6 Astra</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="agent-temperature"
                  className="block text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  Temperature
                </label>
                <input
                  id="agent-temperature"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => {
                    setTemperature(e.target.value);
                    if (errors.temperature)
                      setErrors((prev) => ({
                        ...prev,
                        temperature: undefined,
                      }));
                  }}
                  aria-invalid={!!errors.temperature}
                  className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm dark:bg-slate-950 dark:text-white ${errors.temperature ? "border-red-500" : "border-slate-300 dark:border-slate-700"}`}
                />
                {errors.temperature && (
                  <p
                    className="mt-1 text-xs text-red-600 dark:text-red-400"
                    role="alert"
                  >
                    {errors.temperature}
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor="agent-max-tokens"
                  className="block text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  Max tokens
                </label>
                <input
                  id="agent-max-tokens"
                  type="number"
                  min={1}
                  step={1}
                  value={maxTokens}
                  onChange={(e) => {
                    setMaxTokens(e.target.value);
                    if (errors.maxTokens)
                      setErrors((prev) => ({ ...prev, maxTokens: undefined }));
                  }}
                  aria-invalid={!!errors.maxTokens}
                  className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm dark:bg-slate-950 dark:text-white ${errors.maxTokens ? "border-red-500" : "border-slate-300 dark:border-slate-700"}`}
                />
                {errors.maxTokens && (
                  <p
                    className="mt-1 text-xs text-red-600 dark:text-red-400"
                    role="alert"
                  >
                    {errors.maxTokens}
                  </p>
                )}
              </div>
            </div>
            <div>
              <label
                htmlFor="agent-tools"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Tools (JSON array)
              </label>
              <textarea
                id="agent-tools"
                rows={4}
                value={toolsJsonText}
                onChange={(e) => {
                  setToolsJsonText(e.target.value);
                  if (errors.tools)
                    setErrors((prev) => ({ ...prev, tools: undefined }));
                }}
                aria-invalid={!!errors.tools}
                aria-describedby={
                  errors.tools ? "agent-tools-error" : undefined
                }
                spellCheck={false}
                className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:bg-slate-950 dark:text-white ${errors.tools ? "border-red-500" : "border-slate-300 dark:border-slate-700"}`}
              />
              {errors.tools && (
                <p
                  id="agent-tools-error"
                  className="mt-1 text-xs text-red-600 dark:text-red-400"
                  role="alert"
                >
                  {errors.tools}
                </p>
              )}
            </div>
            {submitError && (
              <p
                role="alert"
                className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
              >
                {submitError}
              </p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !name.trim() || !systemPrompt.trim()}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-950 hover:bg-primary-700 disabled:opacity-50"
              >
                {isSubmitting
                  ? isEdit
                    ? "Saving…"
                    : "Creating…"
                  : isEdit
                    ? "Save Changes"
                    : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </FocusTrap>
  );
}
