import { Component, type ReactNode } from 'react'

interface Props  { children: ReactNode }
interface State  { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
          <p className="text-lg font-semibold text-gray-800 dark:text-gray-200">Something went wrong</p>
          <pre className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 rounded-lg p-4 max-w-xl overflow-auto text-left">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700"
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
