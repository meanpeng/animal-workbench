import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "48px 24px",
          textAlign: "center",
          gap: "16px",
        }}>
          <h2 style={{ margin: 0, fontSize: "1.25rem", color: "#1e293b" }}>
            页面加载出错
          </h2>
          <p style={{ margin: 0, color: "#64748b", maxWidth: "480px", lineHeight: 1.6 }}>
            {this.state.error?.message || "发生了一个意外错误，请尝试刷新页面。"}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: "8px 24px",
              borderRadius: "6px",
              border: "1px solid #e2e8f0",
              background: "#f8fafc",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
