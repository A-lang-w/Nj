import { useState, useEffect, useRef } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useUiStore } from "@/stores/ui-store";
import { APP_NAME } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { COLORS } from "@/lib/theme-colors";

export function AppShell() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasMenuOpenRef = useRef(false);

  // Return focus to the hamburger when the mobile menu closes. The overlay
  // scrim deliberately takes no focus: auto-focusing an invisible button
  // strands keyboard users with no visible indicator.
  useEffect(() => {
    if (wasMenuOpenRef.current && !mobileMenuOpen) {
      menuButtonRef.current?.focus();
    }
    wasMenuOpenRef.current = mobileMenuOpen;
  }, [mobileMenuOpen]);

  return (
    <div
      className="flex h-screen overflow-hidden"
      style={{ backgroundColor: COLORS.bg }}
    >
      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <button
          type="button"
          tabIndex={-1}
          className="fixed inset-0 z-40 bg-black/50 md:hidden cursor-default"
          aria-label="Close navigation"
          onClick={() => setMobileMenuOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") {
              e.preventDefault();
              setMobileMenuOpen(false);
            }
          }}
        />
      )}

      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:bg-white focus:text-black focus:px-4 focus:py-2 focus:rounded"
      >
        Skip to content
      </a>

      {/* Sidebar: hidden on mobile unless toggled, visible on md+ */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex-shrink-0 border-r transition-all duration-200 md:relative md:translate-x-0",
          sidebarCollapsed ? "md:w-16" : "md:w-[260px]",
          mobileMenuOpen
            ? "w-[260px] translate-x-0"
            : "w-[260px] -translate-x-full",
        )}
        style={{
          backgroundColor: COLORS.inputBg,
          borderColor: COLORS.border,
        }}
        // The scrim takes no focus, so Escape must work from anywhere inside
        // the open drawer — otherwise keyboard users are trapped until they
        // Tab all the way back to the hamburger.
        onKeyDown={(e) => {
          if (e.key === "Escape" && mobileMenuOpen) {
            e.stopPropagation();
            setMobileMenuOpen(false);
          }
        }}
      >
        <Sidebar />
      </aside>

      <main id="main-content" className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header with hamburger */}
        <header
          className="flex items-center border-b px-4 py-3 md:hidden"
          style={{ borderColor: COLORS.border }}
        >
          <button
            type="button"
            ref={menuButtonRef}
            className="rounded p-1 text-white hover:bg-white/10"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-label={mobileMenuOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileMenuOpen}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-6 w-6"
              aria-hidden="true"
            >
              {mobileMenuOpen ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              ) : (
                <>
                  <line x1="4" y1="8" x2="20" y2="8" />
                  <line x1="4" y1="16" x2="20" y2="16" />
                </>
              )}
            </svg>
          </button>
          <span className="ml-3 text-sm font-medium text-white">
            {APP_NAME}
          </span>
        </header>
        <Outlet />
      </main>

      {/* Global toast/notification live region for transient messages (A11Y-LIVE-04) */}
      <div
        aria-live="polite"
        aria-atomic="false"
        role="status"
        className="sr-only"
        id="global-toast-live-region"
      />
    </div>
  );
}
