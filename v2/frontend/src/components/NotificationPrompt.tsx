import { useState } from 'react'

const DISMISSED_KEY = 'pa:notif-dismissed'

export function NotificationPrompt() {
  const [visible, setVisible] = useState(() => {
    if (!('Notification' in window)) return false
    if (Notification.permission !== 'default') return false
    try { return !localStorage.getItem(DISMISSED_KEY) } catch { return false }
  })

  if (!visible) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, '1') } catch {}
    setVisible(false)
  }

  const enable = async () => {
    // Must be called inside a user-gesture handler (required on iOS)
    await Notification.requestPermission()
    dismiss()
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-indigo-50 dark:bg-indigo-950/60 border-b border-indigo-100 dark:border-indigo-900 flex-shrink-0">
      {/* Bell icon */}
      <svg className="w-4 h-4 text-indigo-500 dark:text-indigo-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>

      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-indigo-800 dark:text-indigo-200">
          Get notified when docs are due -{' '}
        </span>
        <span className="text-xs text-indigo-600 dark:text-indigo-400">
          enable reminders?
        </span>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={dismiss}
          className="text-xs text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 py-1 px-1.5 rounded transition-colors"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={enable}
          className="text-xs bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white px-3 py-1.5 rounded-lg font-medium transition-colors"
        >
          Enable
        </button>
      </div>
    </div>
  )
}
