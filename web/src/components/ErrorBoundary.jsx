import { Component } from 'react';

/** Last line of defence: a rendering bug shows a recoverable message instead of a blank page. */
export class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('UI error', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="login panel">
        <h1>Something went wrong</h1>
        <p className="muted">The page hit an unexpected error. Reloading usually fixes it.</p>
        <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
