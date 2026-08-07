interface Props {
  title:         string
  message:       string
  confirmLabel?: string
  danger?:       boolean
  onConfirm:     () => void
  onCancel:      () => void
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }: Props) {
  return (
    <div
      className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center"
      onClick={onCancel}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-white dark:bg-gray-900 rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-sm px-6 pt-6 pb-safe-6 flex flex-col gap-3"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{message}</p>
        <div className="flex gap-2 mt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`flex-1 px-4 py-2.5 text-sm font-medium text-white rounded-xl transition-colors ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
