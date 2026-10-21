import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import FocusTrap from "focus-trap-react";
import { useUiStore } from "@/stores/ui-store";
import { useThreadsStore } from "@/stores/threads-store";
import {
  MessageSquarePlus,
  MessageSquare,
  Search,
  Bot,
  Sparkles,
  Brain,
  Store,
  Settings,
  Library,
  Inbox,
} from "lucide-react";

const MAX_THREAD_RESULTS = 5;

export function CommandPalette() {
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const closeCommandPalette = useUiStore((s) => s.closeCommandPalette);
  const threads = useThreadsStore((s) => s.threads);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (commandPaletteOpen) closeCommandPalette();
        else useUiStore.getState().openCommandPalette();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteOpen, closeCommandPalette]);

  useEffect(() => {
    if (!commandPaletteOpen) setQuery("");
  }, [commandPaletteOpen]);

  const threadResults = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    return threads
      .filter((t) => {
        const title = t.title?.toLowerCase() ?? "";
        return title.includes(trimmed) || String(t.id).includes(trimmed);
      })
      .slice(0, MAX_THREAD_RESULTS);
  }, [threads, query]);

  const navItems = useMemo(() => {
    const items = [
      {
        label: "New thread",
        path: "/threads/new",
        icon: MessageSquarePlus,
      },
      { label: "Threads", path: "/threads", icon: Search },
      { label: "Inbox", path: "/inbox", icon: Inbox },
      { label: "Agents", path: "/agents", icon: Bot },
      { label: "Skills", path: "/skills", icon: Sparkles },
      { label: "Memories", path: "/memories", icon: Brain },
      { label: "Library", path: "/library", icon: Library },
      { label: "Marketplace", path: "/marketplace", icon: Store },
      { label: "Settings", path: "/settings", icon: Settings },
    ] as const;
    const q = query.trim().toLowerCase();
    if (!q) return [...items];
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [query]);

  const run = (action: () => void) => {
    action();
    closeCommandPalette();
  };

  if (!commandPaletteOpen) return null;

  return (
    <FocusTrap
      active={commandPaletteOpen}
      focusTrapOptions={{
        allowOutsideClick: true,
        escapeDeactivates: () => {
          closeCommandPalette();
          return false;
        },
      }}
    >
      <div
        className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[20vh] backdrop-blur-sm"
        onClick={closeCommandPalette}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
          onClick={(e) => e.stopPropagation()}
        >
          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-slate-500 dark:[&_[cmdk-group-heading]]:text-slate-400 [&_[cmdk-group]]:not([hidden])_~[cmdk-group]:pt-0 [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2 [&_[cmdk-item]]:text-sm [&_[cmdk-item][data-selected=true]]:bg-primary-50 [&_[cmdk-item][data-selected=true]]:text-primary-700 dark:[&_[cmdk-item][data-selected=true]]:bg-primary-950 dark:[&_[cmdk-item][data-selected=true]]:text-primary-300"
          >
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search threads or type a command…"
              aria-label="Search commands and threads"
              className="w-full border-b border-slate-200 bg-transparent px-4 py-3 text-sm placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:border-slate-800 dark:text-white dark:placeholder:text-slate-400"
              autoFocus
            />
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              <Command.Empty className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                No results found.
              </Command.Empty>

              {threadResults.length > 0 && (
                <Command.Group heading="Threads">
                  {threadResults.map((thread) => {
                    const title = thread.title || `Thread ${thread.id}`;
                    return (
                      <Command.Item
                        key={thread.id}
                        value={`thread-${thread.id}-${title}`}
                        onSelect={() =>
                          run(() => navigate(`/threads/${thread.id}`))
                        }
                      >
                        <MessageSquare
                          className="mr-2 h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />{" "}
                        <span className="truncate">{title}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              {navItems.length > 0 && (
                <Command.Group heading="Navigation">
                  {navItems.map((item) => (
                    <Command.Item
                      key={item.path}
                      value={item.label}
                      onSelect={() => run(() => navigate(item.path))}
                    >
                      <item.icon className="mr-2 h-4 w-4" aria-hidden="true" />{" "}
                      {item.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
            <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-400">
              <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">
                ↑↓
              </kbd>{" "}
              navigate
              <span className="mx-2">·</span>
              <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">
                ↵
              </kbd>{" "}
              select
              <span className="mx-2">·</span>
              <kbd className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">
                esc
              </kbd>{" "}
              close
            </div>
          </Command>
        </div>
      </div>
    </FocusTrap>
  );
}
