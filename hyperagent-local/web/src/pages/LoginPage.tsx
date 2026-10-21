import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth-store";
import { Sparkles } from "lucide-react";
import { APP_NAME } from "@/lib/branding";
import { COLORS } from "@/lib/theme-colors";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const sessionExpiredReason = useAuthStore((s) => s.sessionExpiredReason);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await login(email.trim());
      navigate("/threads", { replace: true });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Login failed. Please try again.",
      );
    }
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4"
      style={{ backgroundColor: "rgb(6, 6, 6)" }}
    >
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <div
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl"
            style={{ backgroundColor: COLORS.textPrimary, color: COLORS.bg }}
          >
            <Sparkles className="h-6 w-6" />
          </div>
          <h1
            className="mt-4 text-2xl font-bold"
            style={{ color: COLORS.textPrimary }}
          >
            {APP_NAME}
          </h1>
          <p className="mt-2 text-sm" style={{ color: COLORS.textSecondary }}>
            Sign in to your local agent workspace
          </p>
        </div>
        {sessionExpiredReason && (
          <p
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
          >
            {sessionExpiredReason}
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium"
              style={{ color: COLORS.textSecondary }}
            >
              Email address
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 block w-full rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none"
              style={{
                backgroundColor: COLORS.inputBg,
                color: COLORS.textPrimary,
                border: `1px solid ${COLORS.border}`,
              }}
            />
          </div>
          <div
            aria-live="polite"
            aria-atomic="true"
            className="min-h-[1.25rem]"
          >
            {error && (
              <p
                role="alert"
                className="text-sm text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={isLoading || !email.trim()}
            className="flex w-full items-center justify-center rounded-lg px-4 py-2 text-sm font-medium focus:outline-none disabled:opacity-50"
            style={{
              backgroundColor: COLORS.textPrimary,
              color: COLORS.bg,
            }}
          >
            {isLoading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p
          className="text-center text-xs"
          style={{ color: COLORS.textSecondary }}
        >
          Any email works — users are created automatically on first login.
        </p>
      </div>
    </div>
  );
}
