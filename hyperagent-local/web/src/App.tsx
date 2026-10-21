import { useEffect, lazy, Suspense } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useAuthStore, SESSION_EXPIRED_MESSAGE } from "@/stores/auth-store";
import { SESSION_EXPIRED_EVENT } from "@/lib/api-client";
import { resetSessionStores } from "@/lib/session-reset";
import { sseClient } from "@/lib/sse-client";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingIndicator } from "@/components/ui/LoadingIndicator";

const CommandPalette = lazy(() =>
  import("@/components/command-palette/CommandPalette").then((m) => ({
    default: m.CommandPalette,
  })),
);

const LoginPage = lazy(() =>
  import("@/pages/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const ThreadListPage = lazy(() =>
  import("@/components/threads/ThreadListPage").then((m) => ({
    default: m.ThreadListPage,
  })),
);
const ThreadDetailPage = lazy(() =>
  import("@/components/threads/ThreadDetailPage").then((m) => ({
    default: m.ThreadDetailPage,
  })),
);
const ThreadNewPage = lazy(() =>
  import("@/components/threads/ThreadNewPage").then((m) => ({
    default: m.ThreadNewPage,
  })),
);
const AgentListPage = lazy(() =>
  import("@/components/agents/AgentListPage").then((m) => ({
    default: m.AgentListPage,
  })),
);
const SkillsPage = lazy(() =>
  import("@/components/skills/SkillsPage").then((m) => ({
    default: m.SkillsPage,
  })),
);
const MemoriesPage = lazy(() =>
  import("@/components/memories/MemoriesPage").then((m) => ({
    default: m.MemoriesPage,
  })),
);
const InboxPage = lazy(() =>
  import("@/components/inbox/InboxPage").then((m) => ({
    default: m.InboxPage,
  })),
);
const MarketplacePage = lazy(() =>
  import("@/components/marketplace/MarketplacePage").then((m) => ({
    default: m.MarketplacePage,
  })),
);
const SettingsPage = lazy(() =>
  import("@/components/settings/SettingsPage").then((m) => ({
    default: m.SettingsPage,
  })),
);

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  if (isLoading) {
    return <LoadingIndicator label="Checking session" />;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

// The detail boundary is keyed per thread: without this, a crash in one
// thread leaves hasError set while navigating to another, so every thread
// view shows the stale error until a full reload.
function ThreadDetailRoute() {
  const { id } = useParams();
  return (
    <ErrorBoundary key={id}>
      <ThreadDetailPage />
    </ErrorBoundary>
  );
}

export default function App() {
  const checkSession = useAuthStore((s) => s.checkSession);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Mid-session expiry: when the shared refresh fails definitively, end the
  // session here with an explanation instead of leaving failing pages behind
  // a stale user. Idempotent and fetch-free, so the handler cannot loop.
  useEffect(() => {
    const onSessionExpired = () => {
      const { user: currentUser, sessionExpiredReason } =
        useAuthStore.getState();
      if (currentUser === null || sessionExpiredReason !== null) return;
      // Drop the dead session's lists with the user, so the next login's first
      // paint cannot show them (failed refetches keep stale data by design).
      resetSessionStores();
      useAuthStore.setState({
        user: null,
        isLoading: false,
        sessionExpiredReason: SESSION_EXPIRED_MESSAGE,
      });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () =>
      window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  }, []);

  useEffect(() => {
    if (user) {
      sseClient.connect();
    } else {
      sseClient.disconnect();
    }
    return () => sseClient.disconnect();
  }, [user]);

  return (
    <>
      {/* CommandPalette is lazy: without its own Suspense + boundary a slow
     chunk suspends the root (blank app, including /login) and a failed
     chunk has no recovery UI. The palette is non-essential, so its failure
     renders nothing instead of the full-page fallback. */}
      <ErrorBoundary fallback={null}>
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      </ErrorBoundary>
      <Suspense fallback={<LoadingIndicator />}>
        {/* Routes-level boundary: /login has no other coverage, so a chunk or
     render failure there would blank the root with no recovery UI. Inner
     boundaries catch first where present. */}
        <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <ProtectedRoute>
                  <ErrorBoundary>
                    <AppShell />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            >
              <Route path="/threads" element={<ThreadListPage />} />
              <Route path="/threads/new" element={<ThreadNewPage />} />
              <Route path="/threads/:id" element={<ThreadDetailRoute />} />
              <Route path="/agents" element={<AgentListPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/memories" element={<MemoriesPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/marketplace" element={<MarketplacePage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/threads" replace />} />
          </Routes>
        </ErrorBoundary>
      </Suspense>
    </>
  );
}
