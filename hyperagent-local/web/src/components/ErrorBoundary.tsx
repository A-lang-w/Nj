import React from "react";
import { COLORS } from "@/lib/theme-colors";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Rendered instead of the full-page fallback when provided. */
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div
          style={{
            backgroundColor: COLORS.bg,
            color: COLORS.textPrimary,
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          }}
        >
          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 600,
              marginBottom: "1rem",
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              fontSize: "0.875rem",
              opacity: 0.7,
              marginBottom: "2rem",
              maxWidth: "32rem",
              textAlign: "center",
            }}
          >
            An unexpected error occurred. Please reload the page to try again.
          </p>
          {this.state.error && (
            <pre
              style={{
                fontSize: "0.75rem",
                opacity: 0.5,
                marginBottom: "2rem",
                maxWidth: "40rem",
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            style={{
              backgroundColor: COLORS.textPrimary,
              color: COLORS.bg,
              border: "none",
              borderRadius: "0.375rem",
              padding: "0.625rem 1.5rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
