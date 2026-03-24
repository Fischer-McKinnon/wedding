'use client'

/**
 * TSK-15: Migrate seating chart from Vite to Next.js
 *
 * Reads from Supabase tables:
 *   - guests (id, name, email, dietary_restrictions, plus_one, plus_one_name)
 *   - tables (id, table_number, table_name, capacity, location_notes)
 *   - seating_assignments (id, guest_id, table_id)
 *
 * Features:
 *   - Drag-and-drop guests onto tables (HTML5 native DnD, no extra deps)
 *   - Drag guests back to the unassigned pool
 *   - Capacity badge per table (green -> amber at full -> red when over)
 *   - Save button persists to Supabase via upsert
 *   - Empty-state handling for no guests / no tables
 *
 * NOTE: Uses the shared browser Supabase client. If RLS is enforced for
 * authenticated users only, wrap this page with an auth check or switch to
 * @supabase/ssr server-client for initial data load.
 */

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// Types

type Guest = {
  id: string
  name: string
  email?: string | null
  dietary_restrictions?: string | null
  plus_one?: boolean
  plus_one_name?: string | null
}

type Table = {
  id: string
  table_number: number
  table_name?: string | null
  capacity: number
  location_notes?: string | null
}

// GuestChip

function GuestChip({
  guest,
  onDragStart,
}: {
  guest: Guest
  onDragStart: (e: React.DragEvent<HTMLDivElement>, guestId: string) => void
}) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, guest.id)}
      className="flex items-center gap-2 px-3 py-2 bg-zinc-100 dark:bg-zinc-900 rounded-md cursor-grab active:cursor-grabbing border border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500 transition-colors select-none"
    >
      <div className="w-6 h-6 rounded-full bg-zinc-300 dark:bg-zinc-700 flex items-center justify-center text-xs font-medium text-zinc-600 dark:text-zinc-300 shrink-0">
        {guest.name[0]?.toUpperCase() ?? '?'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
          {guest.name}
        </div>
        {guest.dietary_restrictions && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
            {guest.dietary_restrictions}
          </div>
        )}
      </div>
      {guest.plus_one && (
        <span className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0">+1</span>
      )}
    </div>
  )
}

// TableCard

function TableCard({
  table,
  guests,
  onDragOver,
  onDrop,
  onGuestDragStart,
}: {
  table: Table
  guests: Guest[]
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop: (e: React.DragEvent<HTMLDivElement>, tableId: string) => void
  onGuestDragStart: (e: React.DragEvent<HTMLDivElement>, guestId: string) => void
}) {
  const [isDragTarget, setIsDragTarget] = useState(false)
  const isOver = guests.length > table.capacity
  const isFull = guests.length === table.capacity

  const borderColor = isDragTarget
    ? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-950/20'
    : isOver
    ? 'border-red-400 dark:border-red-700 bg-red-50/40 dark:bg-red-950/10'
    : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black'

  const badgeColor = isOver
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    : isFull
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400'

  return (
    <div
      onDragOver={(e) => { onDragOver(e); setIsDragTarget(true) }}
      onDragLeave={() => setIsDragTarget(false)}
      onDrop={(e) => { onDrop(e, table.id); setIsDragTarget(false) }}
      className={`rounded-lg border p-4 flex flex-col gap-3 min-h-[11rem] transition-colors ${borderColor}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-black dark:text-white truncate">
            Table {table.table_number}{table.table_name ? ` · ${table.table_name}` : ''}
          </div>
          {table.location_notes && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
              {table.location_notes}
            </div>
          )}
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${badgeColor}`}>
          {guests.length}/{table.capacity}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 flex-1">
        {guests.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-zinc-400 dark:text-zinc-600">Drop guests here</p>
          </div>
        ) : (
          guests.map((guest) => (
            <GuestChip key={guest.id} guest={guest} onDragStart={onGuestDragStart} />
          ))
        )}
      </div>
    </div>
  )
}

// SeatingPage

export default function SeatingPage() {
  const [guests, setGuests] = useState<Guest[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [{ data: guestData }, { data: tableData }, { data: assignmentData }] =
        await Promise.all([
          supabase.from('guests').select('*').order('name'),
          supabase.from('tables').select('*').order('table_number'),
          supabase.from('seating_assignments').select('*'),
        ])
      setGuests(guestData ?? [])
      setTables(tableData ?? [])
      const map: Record<string, string> = {}
      for (const a of assignmentData ?? []) { map[a.guest_id] = a.table_id }
      setAssignments(map)
      setLoading(false)
    }
    load()
  }, [])

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, guestId: string) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', guestId)
    }, []
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
      setAssignments((prev) => ({ ...prev, [guestId]: tableId }))
      setIsDirty(true)
      setSaveStatus('idle')
    }, []
  )

  const handleDropOnUnassigned = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const guestId = e.dataTransfer.getData('text/plain')
    if (!guestId) return
    setAssignments((prev) => { const next = { ...prev }; delete next[guestId]; return next })
    setIsDirty(true)
    setSaveStatus('idle')
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaveStatus('idle')
    try {
      const upserts = Object.entries(assignments).map(([guest_id, table_id]) => ({ guest_id, table_id }))
      if (upserts.length > 0) {
        const { error } = await supabase.from('seating_assignments').upsert(upserts, { onConflict: 'guest_id' })
        if (error) throw error
      }
      const unassignedIds = guests.map((g) => g.id).filter((id) => !assignments[id])
      if (unassignedIds.length > 0) {
        const { error } = await supabase.from('seating_assignments').delete().in('guest_id', unassignedIds)
        if (error) throw error
      }
      setIsDirty(false)
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2500)
    } catch (err) {
      console.error('Seating save error:', err)
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }

  const unassignedGuests = guests.filter((g) => !assignments[g.id])
  const guestsAtTable = (tableId: string) => guests.filter((g) => assignments[g.id] === tableId)
  const totalSeated = guests.length - unassignedGuests.length

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-black flex items-center justify-center font-sans">
        <p className="text-zinc-400 text-sm">Loading seating chart...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-black font-sans">
      <header className="shrink-0 border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 text-sm transition-colors">
            ← Home
          </Link>
          <h1 className="text-xl font-semibold text-black dark:text-white">Seating Chart</h1>
          <span className="text-sm text-zinc-400 dark:text-zinc-500">
            {totalSeated}/{guests.length} seated · {tables.length} tables
          </span>
        </div>
        <div className="flex items-center gap-3">
          {saveStatus === 'saved' && <span className="text-sm text-green-600 dark:text-green-400">✓ Saved</span>}
          {saveStatus === 'error' && <span className="text-sm text-red-500">Error saving — try again</span>}
          <button
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black text-sm font-medium rounded-md disabled:opacity-40 hover:opacity-80 transition-opacity cursor-pointer disabled:cursor-default"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside
          className="w-72 shrink-0 border-r border-zinc-200 dark:border-zinc-800 flex flex-col"
          onDragOver={handleDragOver}
          onDrop={handleDropOnUnassigned}
        >
          <div className="px-4 py-3 shrink-0 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Unassigned · {unassignedGuests.length}
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {guests.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-sm text-zinc-400">No guests yet.</p>
                <Link href="/guests" className="text-xs text-zinc-400 hover:underline mt-1 block">Add guests →</Link>
              </div>
            ) : unassignedGuests.length === 0 ? (
              <p className="text-sm text-zinc-400 dark:text-zinc-600 text-center py-10">All guests seated 🎉</p>
            ) : (
              unassignedGuests.map((guest) => (
                <GuestChip key={guest.id} guest={guest} onDragStart={handleDragStart} />
              ))
            )}
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto p-6">
          {tables.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-zinc-400 text-sm text-center">
                No tables configured.<br />
                <span className="text-xs">Add rows to the tables table in Supabase.</span>
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {tables.map((table) => (
                <TableCard
                  key={table.id}
                  table={table}
                  guests={guestsAtTable(table.id)}
                  onDragOver={handleDragOver}
                  onDrop={handleDropOnTable}
                  onGuestDragStart={handleDragStart}
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
