import { Component, type ReactNode } from 'react';

/**
 * Keeps one widget's failure from taking a page with it: a chip, a full form or a global part that throws is dropped (or replaced
 * by `fallback`) and logged, and the rest of the frame carries on. Widgets are written by several people; the app is not theirs to break.
 */
export class Quiet extends Component<{ children: ReactNode; fallback?: ReactNode; what?: string }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error) {
    console.error(`[glance] ${this.props.what ?? 'a widget'} failed:`, error);
  }

  override render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
