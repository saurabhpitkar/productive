import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export const FIELD_CLS = "w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 text-gray-900 dark:text-gray-100"

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAY_LABELS  = ['Su','Mo','Tu','We','Th','Fr','Sa']
export const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function tomorrowISO(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function Chev({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
        d={dir === 'left' ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'} />
    </svg>
  )
}

// ── Date Picker ───────────────────────────────────────────────────────────────
// value: YYYY-MM-DD ISO string (or '')
// When empty, tomorrow's date is highlighted as the default suggestion.
export function DatePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const today     = todayISO()
  const tomorrow  = tomorrowISO()

  const parseValue = (): Date | null => {
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const d = new Date(value + 'T00:00:00')
      if (!isNaN(d.getTime())) return d
    }
    return null
  }

  const [open,      setOpen]      = useState(false)
  const [viewYear,  setViewYear]  = useState(() => new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth())
  const [pos,       setPos]       = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)

  const openPicker = () => {
    const parsed = parseValue()
    // Default view to tomorrow when no value is set
    const base = parsed ?? new Date(tomorrow + 'T00:00:00')
    setViewYear(base.getFullYear())
    setViewMonth(base.getMonth())
    if (btnRef.current) {
      const r  = btnRef.current.getBoundingClientRect()
      const pH = 320, pW = 288
      const above = r.bottom + pH + 8 > window.innerHeight && r.top > pH + 8
      const top   = above ? r.top - pH - 4 : r.bottom + 4
      let   left  = r.left
      if (left + pW > window.innerWidth - 8) left = window.innerWidth - pW - 8
      if (left < 8) left = 8
      setPos({ top, left })
    }
    setOpen(true)
  }

  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y-1) } else setViewMonth(m => m-1) }
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0);  setViewYear(y => y+1) } else setViewMonth(m => m+1) }

  const selectDay = (day: number) => {
    onChange(`${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`)
    setOpen(false)
  }

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const firstDow    = new Date(viewYear, viewMonth, 1).getDay()
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const displayLabel = (() => {
    const p = parseValue()
    if (!p) return null
    return p.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  })()

  return (
    <>
      <button ref={btnRef} type="button" onClick={openPicker}
        className={`${FIELD_CLS} text-left flex items-center gap-2`}>
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        {displayLabel
          ? <span className="truncate">{displayLabel}</span>
          : <span className="text-gray-400 dark:text-gray-500 truncate">Pick date</span>
        }
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[200]" onPointerDown={() => setOpen(false)} />
          <div
            className="fixed z-[201] w-72 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl p-3 select-none"
            style={{ top: pos.top, left: pos.left }}
            onPointerDown={e => e.stopPropagation()}
          >
            {/* Year row */}
            <div className="flex items-center justify-between mb-1">
              <button type="button" onClick={() => setViewYear(y => y-1)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"><Chev dir="left" /></button>
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">{viewYear}</span>
              <button type="button" onClick={() => setViewYear(y => y+1)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"><Chev dir="right" /></button>
            </div>
            {/* Month row */}
            <div className="flex items-center justify-between mb-3">
              <button type="button" onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"><Chev dir="left" /></button>
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 w-24 text-center">{MONTH_NAMES[viewMonth]}</span>
              <button type="button" onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"><Chev dir="right" /></button>
            </div>
            {/* Day headers */}
            <div className="grid grid-cols-7 mb-1">
              {DAY_LABELS.map(d => <div key={d} className="text-center text-[11px] font-medium text-gray-400 py-0.5">{d}</div>)}
            </div>
            {/* Day cells */}
            <div className="grid grid-cols-7 gap-y-0.5">
              {cells.map((day, i) => {
                if (!day) return <div key={i} />
                const iso        = `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
                const isSel      = iso === value
                const isToday    = iso === today
                // Highlight tomorrow as default when nothing is selected
                const isDefault  = !value && iso === tomorrow
                return (
                  <button key={i} type="button" onClick={() => selectDay(day)}
                    className={['mx-auto flex items-center justify-center w-8 h-8 rounded-full text-sm transition-colors',
                      isSel     ? 'bg-indigo-600 text-white font-semibold'
                      : isDefault ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-semibold ring-2 ring-indigo-400 ring-offset-1'
                      : isToday   ? 'ring-1 ring-indigo-400 text-indigo-600 dark:text-indigo-400 font-medium'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800',
                    ].join(' ')}>
                    {day}
                  </button>
                )
              })}
            </div>
            <div className="flex justify-between mt-3 pt-2 border-t border-gray-100 dark:border-gray-800">
              <button type="button" onClick={() => { onChange(''); setOpen(false) }}
                className="text-xs text-gray-400 hover:text-gray-600 px-1 py-1">Clear</button>
              <button type="button" onClick={() => { onChange(today); setOpen(false) }}
                className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 font-medium px-1 py-1">Today</button>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  )
}

// ── Time Picker ───────────────────────────────────────────────────────────────
// value: HH:MM 24-hour string (or '')
// When empty, defaults to 10:30 as the pre-selected suggestion.
export function TimePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const DEFAULT_H = 10
  const DEFAULT_M = 30

  const parseValue = () => {
    if (value && /^\d{2}:\d{2}$/.test(value))
      return { h: parseInt(value.slice(0,2)), m: parseInt(value.slice(3,5)) }
    return null
  }

  const [open, setOpen] = useState(false)
  const [selH, setSelH] = useState(-1)
  const [selM, setSelM] = useState(-1)
  const [pos,  setPos]  = useState({ top: 0, left: 0 })
  const btnRef  = useRef<HTMLButtonElement>(null)
  const hourRef = useRef<HTMLDivElement>(null)
  const minRef  = useRef<HTMLDivElement>(null)

  const openPicker = () => {
    const parsed = parseValue()
    // When no value, pre-select the default (10:30)
    const h = parsed?.h ?? DEFAULT_H
    const m = parsed ? (MINUTES.includes(parsed.m) ? parsed.m : DEFAULT_M) : DEFAULT_M
    setSelH(h)
    setSelM(m)
    if (btnRef.current) {
      const r   = btnRef.current.getBoundingClientRect()
      const pH  = 260, pW = 192
      const top = r.bottom + pH + 8 > window.innerHeight && r.top > pH + 8
                  ? r.top - pH - 4 : r.bottom + 4
      let left  = r.left
      if (left + pW > window.innerWidth - 8) left = window.innerWidth - pW - 8
      if (left < 8) left = 8
      setPos({ top, left })
    }
    setOpen(true)
    requestAnimationFrame(() => {
      // Scroll to selected (or default) hour and minute
      if (hourRef.current) {
        const idx = parsed?.h ?? DEFAULT_H
        ;(hourRef.current.children[idx] as HTMLElement)?.scrollIntoView({ block: 'center' })
      }
      if (minRef.current) {
        const mIdx = MINUTES.indexOf(parsed ? (MINUTES.includes(parsed.m) ? parsed.m : DEFAULT_M) : DEFAULT_M)
        if (mIdx >= 0) (minRef.current.children[mIdx] as HTMLElement)?.scrollIntoView({ block: 'center' })
      }
    })
  }

  const pickHour = (h: number) => {
    setSelH(h)
    const m = selM >= 0 ? selM : DEFAULT_M
    if (selM < 0) setSelM(DEFAULT_M)
    onChange(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
  }

  const pickMinute = (m: number) => {
    setSelM(m)
    const h = selH >= 0 ? selH : DEFAULT_H
    if (selH < 0) setSelH(DEFAULT_H)
    onChange(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
  }

  const HOURS = Array.from({ length: 24 }, (_, i) => i)
  const displayLabel = parseValue()

  return (
    <>
      <button ref={btnRef} type="button" onClick={openPicker}
        className={`${FIELD_CLS} text-left flex items-center gap-2`}>
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {displayLabel
          ? <span className="truncate">{String(displayLabel.h).padStart(2,'0')}:{String(displayLabel.m).padStart(2,'0')}</span>
          : <span className="text-gray-400 dark:text-gray-500 truncate">Pick time</span>
        }
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[200]" onPointerDown={() => setOpen(false)} />
          <div
            className="fixed z-[201] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl p-3 w-48 select-none"
            style={{ top: pos.top, left: pos.left }}
            onPointerDown={e => e.stopPropagation()}
          >
            <div className="flex gap-2">
              <div className="flex-1">
                <div className="text-[11px] text-center text-gray-400 font-medium mb-1">Hour</div>
                <div ref={hourRef} className="h-44 overflow-y-auto flex flex-col gap-0.5 overscroll-contain">
                  {HOURS.map(h => (
                    <button key={h} type="button" onClick={() => pickHour(h)}
                      className={`py-2 text-sm rounded-lg w-full transition-colors ${
                        selH === h
                          ? 'bg-indigo-600 text-white font-semibold'
                          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}>
                      {String(h).padStart(2,'0')}
                    </button>
                  ))}
                </div>
              </div>
              <div className="w-px bg-gray-100 dark:bg-gray-800 self-stretch" />
              <div className="flex-1">
                <div className="text-[11px] text-center text-gray-400 font-medium mb-1">Min</div>
                <div ref={minRef} className="h-44 overflow-y-auto flex flex-col gap-0.5 overscroll-contain">
                  {MINUTES.map(m => (
                    <button key={m} type="button" onClick={() => pickMinute(m)}
                      className={`py-2 text-sm rounded-lg w-full transition-colors ${
                        selM === m
                          ? 'bg-indigo-600 text-white font-semibold'
                          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}>
                      {String(m).padStart(2,'0')}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-between mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
              <button type="button"
                onClick={() => { onChange(''); setSelH(-1); setSelM(-1); setOpen(false) }}
                className="text-xs text-gray-400 hover:text-gray-600 px-1 py-1">Clear</button>
              <button type="button" onClick={() => setOpen(false)}
                className="text-xs text-indigo-600 dark:text-indigo-400 font-medium px-1 py-1">Done</button>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  )
}
