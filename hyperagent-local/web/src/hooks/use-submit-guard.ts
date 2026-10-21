import { useCallback, useRef, useState } from "react";

/**
 * Duplicate-submit guard for send/resend handlers.
 *
 * A double-Enter in one frame (or a double-clicked Resend, which has no
 * composer clear) would otherwise create twin threads or post the message
 * twice. The ref is the arbiter — state updates land too late for
 * same-frame re-entry — while the state drives the disabled UI.
 */
export function useSubmitGuard() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const runGuarded = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (submittingRef.current) return undefined;
      submittingRef.current = true;
      setIsSubmitting(true);
      try {
        return await fn();
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [],
  );

  return { isSubmitting, submittingRef, runGuarded };
}
