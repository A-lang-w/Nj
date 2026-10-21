import { create } from "zustand";

interface UiState {
  sidebarCollapsed: boolean;
  commandPaletteOpen: boolean;
  activeWorkspaceId: number;
  toggleSidebar: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  setActiveWorkspace: (id: number) => void;
}

// NOTE: a theme toggle existed but was a placebo — the canvas is forced-dark
// and no light theme exists, so switching changed nothing visible. The app is
// dark-only (see <html class="dark">); reintroduce theme state alongside a
// real light theme, not before.

const WORKSPACE_KEY = "hyperagent-active-workspace";
/** Legacy key kept for continuity with existing sessions. */
const LEGACY_WORKSPACE_KEY = "hyperagent-last-active-workspace";

// Storage may be blocked (private mode, disabled cookies): a throwing read
// at module init would crash store creation, so fall back to defaults.
function readStoredWorkspaceId(): number {
  try {
    const raw =
      localStorage.getItem(WORKSPACE_KEY) ??
      localStorage.getItem(LEGACY_WORKSPACE_KEY);
    return Number(raw) || 1;
  } catch {
    return 1;
  }
}

function writeStoredWorkspaceId(id: number): void {
  try {
    const value = String(id);
    localStorage.setItem(WORKSPACE_KEY, value);
    // Keep the legacy key in sync so older builds / other tabs still restore.
    localStorage.setItem(LEGACY_WORKSPACE_KEY, value);
  } catch {
    // Best effort: the in-memory state still updates below.
  }
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  activeWorkspaceId: readStoredWorkspaceId(),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  setActiveWorkspace: (id) => {
    writeStoredWorkspaceId(id);
    set({ activeWorkspaceId: id });
  },
}));
