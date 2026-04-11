'use client'

/**
 * TSK-17: Seating chart, Riley & Grey CSV edition
 *
 * - Imports the Riley & Grey RSVP CSV format (columns: Guest Name, Attending?,
 *   Welcome Dinner, Boat Transfer to the Château, Wedding Ceremony,
 *   Farewell Brunch, Entree, Hotel, Food Allergy, …).
 * - Parses indented "  with <Name>" rows as +1s linked to the preceding primary
 *   guest via householdId.
 * - Drag-and-drop guests onto tables, or drop an entire household at once.
 * - Category dashboard: entree counts, event attendance, allergies, hotels.
 * - Export: dump seated guests as a CSV.
 * - Persistence: imported guests + seating assignments + table layout are
 *   stored in localStorage, keyed by 'wedding-seating-v1'. No Supabase here —
 *   this page is self-contained and works offline.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import type { RGGuest, SeatingTable as Table } from './types'
import { SEED_GUESTS } from './guestSeed'

type PersistedState = {
  guests: RGGuest[]
  tables: Table[]
  assignments: Record<string, string> // guestId -> tableId
}

const STORAGE_KEY = 'wedding-seating-v2'

// ─── Default tables ───────────────────────────────────────────────────────────

const DEFAULT_TABLES: Table[] = [
  { id: 't-sweetheart', number: 1, name: 'Sweetheart', capacity: 2 },
  { id: 't-mckinnon', number: 2, name: 'McKinnon Family', capacity: 10 },
  { id: 't-fischer', number: 3, name: 'Fischer Family', capacity: 10 },
  { id: 't-old-friends', number: 4, name: 'Old Friends', capacity: 8 },
  { id: 't-college', number: 5, name: 'College', capacity: 8 },
  { id: 't-work-a', number: 6, name: 'Work (Andrea)', capacity: 8 },
  { id: 't-work-m', number: 7, name: 'Work (Markus)', capacity: 8 },
  { id: 't-kids', number: 8, name: 'Kids', capacity: 6 },
]

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/** Minimal CSV line parser that handles double-quoted fields with commas. */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        inQuote = !inQuote
      }
    } else if (c === ',' && !inQuote) {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out
}

/** Split CSV text into logical rows, respecting quoted newlines. */
function splitCsvRows(csv: string): string[] {
  const rows: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (c === '"') {
      inQuote = !inQuote
      cur += c
    } else if ((c === '\n' || c === '\r') && !inQuote) {
      if (cur.length) rows.push(cur)
      cur = ''
      if (c === '\r' && csv[i + 1] === '\n') i++
    } else {
      cur += c
    }
  }
  if (cur.length) rows.push(cur)
  return rows
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function parseRGCsv(csv: string): RGGuest[] {
  const rows = splitCsvRows(csv)
  if (rows.length < 2) return []
  const header = parseCsvLine(rows[0]).map((h) => h.trim())
  const findIdx = (matcher: (h: string) => boolean) =>
    header.findIndex(matcher)

  const i = {
    name: findIdx((h) => /guest\s*name/i.test(h)),
    attending: findIdx((h) => /attending/i.test(h)),
    welcome: findIdx((h) => /welcome.*dinner/i.test(h)),
    boat: findIdx((h) => /boat/i.test(h)),
    ceremony: findIdx((h) => /ceremony/i.test(h)),
    brunch: findIdx((h) => /brunch/i.test(h)),
    entree: findIdx((h) => /entree|entrée/i.test(h)),
    hotel: findIdx((h) => /hotel/i.test(h)),
    allergy: findIdx((h) => /allerg/i.test(h)),
    email: findIdx((h) => /email/i.test(h)),
    phone: findIdx((h) => /phone/i.test(h)),
    addr: findIdx((h) => /address\s*1/i.test(h)),
    rsvp: findIdx((h) => /rsvp.*on/i.test(h)),
  }

  const guests: RGGuest[] = []
  let currentHousehold = ''
  const yn = (s?: string) => /yes/i.test((s ?? '').trim())
  const get = (cols: string[], idx: number) =>
    idx >= 0 && idx < cols.length ? cols[idx] : ''

  rows.slice(1).forEach((line, rowIdx) => {
    const cols = parseCsvLine(line)
    const rawName = get(cols, i.name)
    if (!rawName || !rawName.trim()) return
    const isPlusOne = /^\s+with\s+/i.test(rawName) || /^\s*with\s+/i.test(rawName)
    const cleanName = rawName
      .replace(/^\s*(with\s+)?/i, '')
      .trim()
    if (!cleanName) return
    if (!isPlusOne || !currentHousehold) {
      currentHousehold = `hh-${rowIdx}-${slug(cleanName)}`
    }
    guests.push({
      id: `g-${rowIdx}-${slug(cleanName)}`,
      name: cleanName,
      householdId: currentHousehold,
      isPrimary: !isPlusOne,
      attending: get(cols, i.attending).trim(),
      welcomeDinner: yn(get(cols, i.welcome)),
      boatTransfer: yn(get(cols, i.boat)),
      ceremony: yn(get(cols, i.ceremony)),
      brunch: yn(get(cols, i.brunch)),
      entree: get(cols, i.entree).trim(),
      hotel: get(cols, i.hotel).trim(),
      allergy: get(cols, i.allergy).trim(),
      email: get(cols, i.email).trim(),
      phone: get(cols, i.phone).trim(),
      address: get(cols, i.addr).trim(),
      rsvpdOn: get(cols, i.rsvp).trim(),
    })
  })
  return guests
}

// ─── Category colour map ──────────────────────────────────────────────────────

const ENTREE_COLORS: Record<string, string> = {
  beef: '#7a3b1e',
  fish: '#1a4a6e',
  salmon: '#1a4a6e',
  chicken: '#c9a96e',
  vegetarian: '#2d5a3e',
  veg: '#2d5a3e',
  vegan: '#2d5a3e',
  kids: '#b15b8d',
  'kids meal': '#b15b8d',
}

function entreeColor(entree: string): string {
  const k = entree.toLowerCase().trim()
  for (const key of Object.keys(ENTREE_COLORS)) {
    if (k.includes(key)) return ENTREE_COLORS[key]
  }
  return '#9a9a9a'
}

// ─── GuestChip ────────────────────────────────────────────────────────────────

function GuestChip({
  guest,
  onDragStart,
  compact = false,
}: {
  guest: RGGuest
  onDragStart: (e: React.DragEvent<HTMLDivElement>, guest: RGGuest) => void
  compact?: boolean
}) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, guest)}
      className="flex items-center gap-2 px-2.5 py-1.5 bg-white dark:bg-zinc-900 rounded-md cursor-grab active:cursor-grabbing border border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors select-none"
      title={guest.name}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: entreeColor(guest.entree) }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">
          {guest.isPrimary ? guest.name : `+ ${guest.name}`}
        </div>
        {!compact && (guest.entree || guest.allergy) && (
          <div className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate">
            {guest.entree}
            {guest.allergy ? ` · ⚠ ${guest.allergy}` : ''}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── TableCard ────────────────────────────────────────────────────────────────

function TableCard({
  table,
  guests,
  onDragOver,
  onDrop,
  onGuestDragStart,
  onRemove,
}: {
  table: Table
  guests: RGGuest[]
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop: (e: React.DragEvent<HTMLDivElement>, tableId: string) => void
  onGuestDragStart: (e: React.DragEvent<HTMLDivElement>, guest: RGGuest) => void
  onRemove: (tableId: string) => void
}) {
  const [isOver, setIsOver] = useState(false)
  const overCap = guests.length > table.capacity
  const atCap = guests.length === table.capacity

  const borderColor = isOver
    ? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-950/20'
    : overCap
    ? 'border-red-400 dark:border-red-700 bg-red-50/40 dark:bg-red-950/10'
    : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/40'

  const badgeColor = overCap
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    : atCap
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400'

  return (
    <div
      onDragOver={(e) => {
        onDragOver(e)
        setIsOver(true)
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        onDrop(e, table.id)
        setIsOver(false)
      }}
      className={`rounded-lg border p-3 flex flex-col gap-2 min-h-[10rem] transition-colors ${borderColor}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-zinc-400 dark:text-zinc-500">
            Table {table.number}
          </div>
          <div className="text-sm font-semibold text-black dark:text-white truncate">
            {table.name}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${badgeColor}`}
          >
            {guests.length}/{table.capacity}
          </span>
          <button
            onClick={() => onRemove(table.id)}
            className="text-zinc-300 hover:text-red-500 text-xs"
            title="Remove table"
          >
            ×
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1 flex-1">
        {guests.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[11px] text-zinc-400 dark:text-zinc-600">
              Drop guests here
            </p>
          </div>
        ) : (
          guests.map((g) => (
            <GuestChip key={g.id} guest={g} onDragStart={onGuestDragStart} compact />
          ))
        )}
      </div>
    </div>
  )
}

// ─── Category dashboard ───────────────────────────────────────────────────────

function StatBar({
  label,
  value,
  total,
  color,
}: {
  label: string
  value: number
  total: number
  color: string
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-zinc-600 dark:text-zinc-300 truncate">{label}</span>
        <span className="text-zinc-400 dark:text-zinc-500 tabular-nums">
          {value} · {pct}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-900 overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  )
}

function CategoryDashboard({
  guests,
  assignments,
  tables,
}: {
  guests: RGGuest[]
  assignments: Record<string, string>
  tables: Table[]
}) {
  const stats = useMemo(() => {
    const attending = guests // the CSV only lists people who RSVP'd — treat all rows as attending
    const total = attending.length
    const seated = attending.filter((g) => assignments[g.id]).length

    // Entrees
    const entreeMap = new Map<string, number>()
    attending.forEach((g) => {
      const key = g.entree || 'Unspecified'
      entreeMap.set(key, (entreeMap.get(key) ?? 0) + 1)
    })
    const entrees = Array.from(entreeMap.entries()).sort((a, b) => b[1] - a[1])

    // Events
    const events = [
      { key: 'welcomeDinner', label: 'Welcome Dinner' },
      { key: 'boatTransfer', label: 'Boat Transfer' },
      { key: 'ceremony', label: 'Ceremony' },
      { key: 'brunch', label: 'Farewell Brunch' },
    ] as const
    const eventCounts = events.map((e) => ({
      label: e.label,
      count: attending.filter((g) => g[e.key]).length,
    }))

    // Allergies
    const allergies = attending
      .filter((g) => g.allergy && g.allergy.length > 0)
      .map((g) => ({ name: g.name, allergy: g.allergy }))

    // Hotels
    const hotelMap = new Map<string, number>()
    attending.forEach((g) => {
      const key = g.hotel || 'Unspecified'
      hotelMap.set(key, (hotelMap.get(key) ?? 0) + 1)
    })
    const hotels = Array.from(hotelMap.entries()).sort((a, b) => b[1] - a[1])

    // Table capacity
    const totalCap = tables.reduce((s, t) => s + t.capacity, 0)

    return { total, seated, entrees, eventCounts, allergies, hotels, totalCap }
  }, [guests, assignments, tables])

  if (stats.total === 0) {
    return (
      <div className="p-4 text-xs text-zinc-400 dark:text-zinc-600 text-center">
        Import a CSV to see category stats.
      </div>
    )
  }

  return (
    <div className="p-4 space-y-5 text-xs">
      {/* Progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold uppercase tracking-wider text-[10px] text-zinc-500 dark:text-zinc-400">
            Seating Progress
          </span>
          <span className="text-zinc-400 tabular-nums">
            {stats.seated}/{stats.total}
          </span>
        </div>
        <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-900 overflow-hidden">
          <div
            className="h-full bg-emerald-500 transition-[width] duration-300"
            style={{
              width: `${stats.total ? (stats.seated / stats.total) * 100 : 0}%`,
            }}
          />
        </div>
        <div className="text-[10px] text-zinc-400">
          Capacity: {stats.totalCap} across {tables.length} tables
        </div>
      </div>

      {/* Entrees */}
      <div className="space-y-2">
        <div className="font-semibold uppercase tracking-wider text-[10px] text-zinc-500 dark:text-zinc-400">
          Entrées
        </div>
        <div className="space-y-2">
          {stats.entrees.map(([label, count]) => (
            <StatBar
              key={label}
              label={label}
              value={count}
              total={stats.total}
              color={entreeColor(label)}
            />
          ))}
        </div>
      </div>

      {/* Events */}
      <div className="space-y-2">
        <div className="font-semibold uppercase tracking-wider text-[10px] text-zinc-500 dark:text-zinc-400">
          Event Attendance
        </div>
        <div className="space-y-2">
          {stats.eventCounts.map((e) => (
            <StatBar
              key={e.label}
              label={e.label}
              value={e.count}
              total={stats.total}
              color="#2c4a3e"
            />
          ))}
        </div>
      </div>

      {/* Hotels */}
      <div className="space-y-2">
        <div className="font-semibold uppercase tracking-wider text-[10px] text-zinc-500 dark:text-zinc-400">
          Hotels
        </div>
        <ul className="space-y-1">
          {stats.hotels.map(([name, count]) => (
            <li
              key={name}
              className="flex items-center justify-between gap-2 text-[11px]"
            >
              <span className="truncate text-zinc-600 dark:text-zinc-300">
                {name}
              </span>
              <span className="text-zinc-400 tabular-nums shrink-0">{count}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Allergies */}
      <div className="space-y-2">
        <div className="font-semibold uppercase tracking-wider text-[10px] text-zinc-500 dark:text-zinc-400">
          Allergies & Dietary ({stats.allergies.length})
        </div>
        {stats.allergies.length === 0 ? (
          <div className="text-[11px] text-zinc-400">None reported</div>
        ) : (
          <ul className="space-y-1.5">
            {stats.allergies.map((a, idx) => (
              <li
                key={`${a.name}-${idx}`}
                className="text-[11px] text-zinc-600 dark:text-zinc-300"
              >
                <span className="font-medium">{a.name}</span>
                <span className="text-zinc-400"> · {a.allergy}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ─── Import modal ─────────────────────────────────────────────────────────────

function ImportModal({
  open,
  onClose,
  onImport,
}: {
  open: boolean
  onClose: () => void
  onImport: (guests: RGGuest[]) => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  if (!open) return null

  const handleParse = () => {
    try {
      const guests = parseRGCsv(text)
      if (guests.length === 0) {
        setError('No guests found. Check that the CSV has a Guest Name column.')
        return
      }
      onImport(guests)
      setText('')
      setError('')
      onClose()
    } catch (e) {
      setError(`Parse error: ${(e as Error).message}`)
    }
  }

  const handleFile = async (file: File) => {
    const content = await file.text()
    setText(content)
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-950 rounded-lg border border-zinc-200 dark:border-zinc-800 w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-base font-semibold text-black dark:text-white">
            Update RSVPs from Riley &amp; Grey
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Paste or upload the latest RSVP export. Guests are matched by name
            and their preferences (entrée, allergy, hotel, event attendance)
            are merged into the existing guest list. New names are appended.
          </p>
        </div>
        <div className="p-5 space-y-3 overflow-auto">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="text-xs px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            Choose file…
          </button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Guest Name,Attending?,Welcome Dinner,..."
            className="w-full h-64 text-xs font-mono rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-black p-3 text-zinc-900 dark:text-zinc-100 resize-none"
          />
          {error && <div className="text-xs text-red-500">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-md text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            onClick={handleParse}
            className="text-sm px-4 py-1.5 rounded-md bg-black dark:bg-white text-white dark:text-black font-medium hover:opacity-80"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── SeatingPage ──────────────────────────────────────────────────────────────

export default function SeatingPage() {
  const [guests, setGuests] = useState<RGGuest[]>([])
  const [tables, setTables] = useState<Table[]>(DEFAULT_TABLES)
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [showDashboard, setShowDashboard] = useState(true)

  // Load from localStorage on mount, fall back to seed guest list
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState
        setGuests(parsed.guests ?? SEED_GUESTS)
        setTables(parsed.tables ?? DEFAULT_TABLES)
        setAssignments(parsed.assignments ?? {})
      } else {
        setGuests(SEED_GUESTS)
      }
    } catch (e) {
      console.warn('Failed to load seating state:', e)
      setGuests(SEED_GUESTS)
    }
    setLoaded(true)
  }, [])

  // Persist changes
  useEffect(() => {
    if (!loaded) return
    try {
      const state: PersistedState = { guests, tables, assignments }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (e) {
      console.warn('Failed to save seating state:', e)
    }
  }, [guests, tables, assignments, loaded])

  // ── Drag handlers ────────────────────────────────────────────────────────

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, guest: RGGuest) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', guest.id)
      // Also carry household id so we can opt into whole-household drop
      e.dataTransfer.setData('application/x-household', guest.householdId)
    },
    []
  )

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDropOnTable = useCallback(
    (e: React.DragEvent<HTMLDivElement>, tableId: string) => {
      e.preventDefault()
      const guestId = e.dataTransfer.getData('text/plain')
      if (!guestId) return
      const householdId = e.dataTransfer.getData('application/x-household')
      const withShift = e.shiftKey
      setAssignments((prev) => {
        const next = { ...prev }
        if (withShift && householdId) {
          guests
            .filter((g) => g.householdId === householdId)
            .forEach((g) => (next[g.id] = tableId))
        } else {
          next[guestId] = tableId
        }
        return next
      })
    },
    [guests]
  )

  const handleDropOnUnassigned = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      const guestId = e.dataTransfer.getData('text/plain')
      if (!guestId) return
      setAssignments((prev) => {
        const next = { ...prev }
        delete next[guestId]
        return next
      })
    },
    []
  )

  // ── Table management ────────────────────────────────────────────────────

  const addTable = () => {
    const nextNum = tables.reduce((m, t) => Math.max(m, t.number), 0) + 1
    setTables((prev) => [
      ...prev,
      {
        id: `t-${Date.now()}`,
        number: nextNum,
        name: `Table ${nextNum}`,
        capacity: 8,
      },
    ])
  }

  const removeTable = (tableId: string) => {
    setTables((prev) => prev.filter((t) => t.id !== tableId))
    setAssignments((prev) => {
      const next: Record<string, string> = {}
      for (const [gid, tid] of Object.entries(prev)) {
        if (tid !== tableId) next[gid] = tid
      }
      return next
    })
  }

  // ── Import / export ─────────────────────────────────────────────────────

  /**
   * Merge an imported Riley & Grey RSVP CSV into the existing guest list by
   * matching on normalised name. Updates preferences (entree, allergy, hotel,
   * event attendance, attending status, contact info) for guests that already
   * exist; appends any brand-new guests found in the RSVP file.
   */
  const handleImport = (imported: RGGuest[]) => {
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, '').trim()

    setGuests((prev) => {
      const byName = new Map<string, RGGuest>()
      prev.forEach((g) => byName.set(norm(g.name), g))

      let updated = 0
      let added = 0
      const merged: RGGuest[] = prev.map((g) => ({ ...g }))
      const mergedByName = new Map<string, RGGuest>()
      merged.forEach((g) => mergedByName.set(norm(g.name), g))

      for (const rsvp of imported) {
        const key = norm(rsvp.name)
        const existing = mergedByName.get(key)
        if (existing) {
          // Preserve id & householdId, overwrite RSVP-derived fields.
          existing.attending = rsvp.attending || existing.attending
          existing.welcomeDinner = rsvp.welcomeDinner
          existing.boatTransfer = rsvp.boatTransfer
          existing.ceremony = rsvp.ceremony
          existing.brunch = rsvp.brunch
          existing.entree = rsvp.entree || existing.entree
          existing.hotel = rsvp.hotel || existing.hotel
          existing.allergy = rsvp.allergy || existing.allergy
          existing.email = rsvp.email || existing.email
          existing.phone = rsvp.phone || existing.phone
          existing.address = rsvp.address || existing.address
          existing.rsvpdOn = rsvp.rsvpdOn || existing.rsvpdOn
          updated++
        } else {
          merged.push(rsvp)
          mergedByName.set(key, rsvp)
          added++
        }
      }
      // Report to the console so it's visible but non-blocking.
      console.log(
        `[seating] RSVP merge complete: ${updated} updated, ${added} added.`
      )
      return merged
    })
  }

  const handleExport = () => {
    const rows: string[] = []
    rows.push(
      [
        'Table Number',
        'Table Name',
        'Guest Name',
        'Entree',
        'Allergy',
        'Welcome Dinner',
        'Boat Transfer',
        'Ceremony',
        'Brunch',
        'Hotel',
      ].join(',')
    )
    const escape = (s: string) =>
      /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    for (const t of tables) {
      const tableGuests = guests.filter((g) => assignments[g.id] === t.id)
      for (const g of tableGuests) {
        rows.push(
          [
            String(t.number),
            t.name,
            g.name,
            g.entree,
            g.allergy,
            g.welcomeDinner ? 'YES' : '',
            g.boatTransfer ? 'YES' : '',
            g.ceremony ? 'YES' : '',
            g.brunch ? 'YES' : '',
            g.hotel,
          ]
            .map(escape)
            .join(',')
        )
      }
    }
    // Unassigned
    const unassigned = guests.filter((g) => !assignments[g.id])
    for (const g of unassigned) {
      rows.push(
        [
          '',
          'UNASSIGNED',
          g.name,
          g.entree,
          g.allergy,
          g.welcomeDinner ? 'YES' : '',
          g.boatTransfer ? 'YES' : '',
          g.ceremony ? 'YES' : '',
          g.brunch ? 'YES' : '',
          g.hotel,
        ]
          .map(escape)
          .join(',')
      )
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'seating-chart.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleClear = () => {
    if (confirm('Clear all guests, assignments, and reset tables?')) {
      setGuests([])
      setAssignments({})
      setTables(DEFAULT_TABLES)
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────────

  const unassigned = guests.filter((g) => !assignments[g.id])
  const householdsUnassigned = useMemo(() => {
    const map = new Map<string, RGGuest[]>()
    unassigned.forEach((g) => {
      const list = map.get(g.householdId) ?? []
      list.push(g)
      map.set(g.householdId, list)
    })
    return Array.from(map.entries())
  }, [unassigned])
  const guestsAtTable = (tableId: string) =>
    guests.filter((g) => assignments[g.id] === tableId)
  const totalSeated = guests.length - unassigned.length

  if (!loaded) {
    return (
      <div className="min-h-screen bg-white dark:bg-black flex items-center justify-center font-sans">
        <p className="text-zinc-400 text-sm">Loading seating chart…</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-black font-sans">
      {/* Header */}
      <header className="shrink-0 border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-4 min-w-0">
          <Link
            href="/"
            className="text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 text-sm transition-colors"
          >
            ← Home
          </Link>
          <h1 className="text-xl font-semibold text-black dark:text-white truncate">
            Seating Chart
          </h1>
          <span className="text-sm text-zinc-400 dark:text-zinc-500 hidden md:inline">
            {totalSeated}/{guests.length} seated · {tables.length} tables
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setImportOpen(true)}
            className="text-xs px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            Update RSVPs
          </button>
          <button
            onClick={addTable}
            className="text-xs px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            + Table
          </button>
          <button
            onClick={handleExport}
            disabled={guests.length === 0}
            className="text-xs px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-40"
          >
            Export
          </button>
          <button
            onClick={() => setShowDashboard((s) => !s)}
            className="text-xs px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            {showDashboard ? 'Hide' : 'Show'} stats
          </button>
          <button
            onClick={handleClear}
            className="text-xs px-3 py-1.5 rounded-md text-zinc-400 hover:text-red-500"
          >
            Reset
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: unassigned guests */}
        <aside
          className="w-72 shrink-0 border-r border-zinc-200 dark:border-zinc-800 flex flex-col"
          onDragOver={handleDragOver}
          onDrop={handleDropOnUnassigned}
        >
          <div className="px-4 py-3 shrink-0 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Unassigned · {unassigned.length}
            </h2>
            <span className="text-[10px] text-zinc-400">
              Shift-drop = whole party
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {guests.length === 0 ? (
              <div className="text-center py-10 space-y-2">
                <p className="text-sm text-zinc-400">No guests yet.</p>
                <button
                  onClick={() => setImportOpen(true)}
                  className="text-xs text-zinc-600 dark:text-zinc-300 underline"
                >
                  Update from Riley &amp; Grey RSVPs →
                </button>
              </div>
            ) : unassigned.length === 0 ? (
              <p className="text-sm text-zinc-400 dark:text-zinc-600 text-center py-10">
                All guests seated 🎉
              </p>
            ) : (
              householdsUnassigned.map(([hhId, members]) => (
                <div
                  key={hhId}
                  className="space-y-1 p-2 rounded-md border border-dashed border-zinc-200 dark:border-zinc-800"
                >
                  <div className="text-[10px] uppercase tracking-wider text-zinc-400">
                    Party of {members.length}
                  </div>
                  {members.map((g) => (
                    <GuestChip
                      key={g.id}
                      guest={g}
                      onDragStart={handleDragStart}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Main: tables */}
        <main className="flex-1 overflow-y-auto p-6">
          {tables.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-zinc-400 text-sm text-center">
                No tables yet.
                <br />
                <button
                  onClick={addTable}
                  className="text-xs text-zinc-600 dark:text-zinc-300 underline mt-2"
                >
                  Add your first table →
                </button>
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {tables.map((table) => (
                <TableCard
                  key={table.id}
                  table={table}
                  guests={guestsAtTable(table.id)}
                  onDragOver={handleDragOver}
                  onDrop={handleDropOnTable}
                  onGuestDragStart={handleDragStart}
                  onRemove={removeTable}
                />
              ))}
            </div>
          )}
        </main>

        {/* Right: category dashboard */}
        {showDashboard && (
          <aside className="w-72 shrink-0 border-l border-zinc-200 dark:border-zinc-800 overflow-y-auto bg-zinc-50/40 dark:bg-zinc-950/40">
            <div className="px-4 py-3 shrink-0 border-b border-zinc-200 dark:border-zinc-800">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Overview
              </h2>
            </div>
            <CategoryDashboard
              guests={guests}
              assignments={assignments}
              tables={tables}
            />
          </aside>
        )}
      </div>

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={handleImport}
      />
    </div>
  )
}
