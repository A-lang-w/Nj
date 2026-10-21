import { useCallback, useRef } from "react";

const TOAST_LIVE_REGION_ID = "global-toast-live-region";
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Writes a transient message into the global toast live region declared in
 * AppShell. The region uses aria-live="polite" so screen readers announce
 * updates without interrupting current speech. Messages are cleared after
 * `timeoutMs` (default 4s) to avoid stale announcements accumulating.
 */
export function useToast() {
  const timerRef = useRef<number | null>(null);

  const showToast = useCallback(
    (message: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) => {
      const region = document.getElementById(TOAST_LIVE_REGION_ID);
      if (!region) return;

      // Clear any pending auto-clear so rapid calls don't leave ghost timers.
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      region.textContent = message;

      timerRef.current = window.setTimeout(() => {
        // Only clear if the region still holds this message; another call may
        // have replaced it before the timeout fired.
        if (region.textContent === message) {
          region.textContent = "";
        }
        timerRef.current = null;
      }, timeoutMs);
    },
    [],
  );

  return { showToast };
}
