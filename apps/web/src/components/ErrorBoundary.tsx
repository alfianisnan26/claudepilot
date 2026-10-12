import { Button, EmptyState } from '@isnanme/ui';
import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';

/**
 * Keeps a failed page from taking the whole app with it. React unmounts everything under an error nobody
 * catches, which left a tab that had been open across a deploy blank: its next lazy page asked for a script
 * the new build no longer has. Instead the page says what happened and offers Reload (which picks up the new
 * build). `resetKey` (the route) clears the error when you navigate somewhere else.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error('[app] a page failed:', error);
  }

  override componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A script that is no longer on the server: the app was updated while this tab was open.
    const stale = /dynamically imported module|Importing a module script failed|Failed to fetch|Loading chunk|MIME type/i.test(`${error.name} ${error.message}`);
    return (
      <div className="mx-auto flex min-h-dvh max-w-lg items-center px-4 py-10">
        <EmptyState
          className="w-full"
          icon={<TriangleAlert className="size-5" />}
          title={stale ? 'The app was updated' : 'This page hit a problem'}
          action={
            <Button onClick={() => location.reload()}>
              Reload
            </Button>
          }
        >
          {stale ? 'A newer version is being served. Reload to get it.' : 'Reload to try again. If it keeps happening, tell whoever runs this portal.'}
        </EmptyState>
      </div>
    );
  }
}
