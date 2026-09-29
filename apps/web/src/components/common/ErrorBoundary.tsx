import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isStaleChunk, reloadForUpdate } from '@/lib/reload'

/** Shown instead of a blank page when something in the app breaks. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack)
    if (isStaleChunk(error)) reloadForUpdate()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-sm">
          <p className="text-base font-semibold">Something went wrong</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {isStaleChunk(error)
              ? 'Kanbanto was updated while this page was open. Reload to get the new version.'
              : 'Reloading usually fixes it. Your saved work is safe on the server.'}
          </p>
          <button onClick={() => location.reload()} className="mt-4 text-sm font-medium text-primary hover:underline">
            Reload
          </button>
          <details className="mt-4 text-left text-xs text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            <pre className="mt-2 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">{error.message}</pre>
          </details>
        </div>
      </div>
    )
  }
}
