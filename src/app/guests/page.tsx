'use client'

/**
 * TSK-14: Build guest management page (/guests)
 *
 * Place this file at: src/app/guests/page.tsx
 *
 * Features:
 *   - Sortable, searchable guest table
 *   - Add / edit guests via modal form
 *   - Delete with confirmation
 *   - Click RSVP badge to cycle status (pending → confirmed → declined)
 *   - CSV import with column-mapping preview
 *
 * Reads/writes Supabase table:
 *   guests (id, name, email, rsvp_status, dietary_restrictions, plus_one, plus_one_name, created_at)
 */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ─── Types ─────────────────────────────────────────────────────────────────────

type RsvpStatus = 'pending' | 'confirmed' | 'declined'

interface Guest {
  id: string
  name: string
  email: string | null
  rsvp_status: RsvpStatus
  dietary_restrictions: string | null
  plus_one: boolean
  plus_one_name: string | null
  created_at: string
}

type GuestDraft = Omit<Guest, 'id' | 'created_at'>

type SortField = 'name' | 'email' | 'rsvp_status' | 'created_at'
type SortDir = 'asc' | 'desc'

type ModalState =
  | { type: 'closed' }
  | { type: 'add' }
  | { type: 'edit'; guest: Guest }
  | { type: 'delete'; guest: Guest }
  | { type: 'csv' }

// ─── Constants ─────────────────────────────────────────────────────────────────

const RSVP_LABEL: Record<RsvpStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  declined: 'Declined',
}

const RSVP_BADGE: Record<RsvpStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800 ring-yellow-200',
  confirmed: 'bg-green-100 text-green-800 ring-green-200',
  declined: 'bg-red-100 text-red-800 ring-red-200',
}

const EMPTY_DRAFT: GuestDraft = {
  name: '',
  email: null,
  rsvp_status: 'pending',
  dietary_restrictions: null,
  plus_one: false,
  plus_one_name: null,
}

// ─── CSV Helpers ───────────────────────────────────────────────────────────────

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 1) return { headers: [], rows: [] }

  function parseRow(line: string): string[] {
    const result: string[] = []
    let field = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { field += '"'; i++ }
        else if (ch === '"') { inQuotes = false }
        else { field += ch }
      } else {
        if (ch === '"') { inQuotes = true }
        else if (ch === ',') { result.push(field.trim()); field = '' }
        else { field += ch }
      }
    }
    result.push(field.trim())
    return result
  }

  const headers = parseRow(lines[0])
  const rows = lines.slice(1).filter(l => l.trim()).map(line => {
    const values = parseRow(line)
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))
  })
  return { headers, rows }
}

const SCHEMA_FIELDS: { key: keyof GuestDraft; label: string; aliases: string[] }[] = [
  { key: 'name', label: 'Name', aliases: ['name', 'full name', 'full_name', 'guest', 'guest name'] },
  { key: 'email', label: 'Email', aliases: ['email', 'email address', 'email_address'] },
  { key: 'rsvp_status', label: 'RSVP Status', aliases: ['rsvp', 'rsvp_status', 'rsvp status', 'status'] },
  { key: 'dietary_restrictions', label: 'Dietary Restrictions', aliases: ['dietary', 'dietary_restrictions', 'restrictions', 'allergies', 'food restrictions'] },
  { key: 'plus_one', label: 'Plus One', aliases: ['plus_one', 'plus one', '+1', 'plus1'] },
  { key: 'plus_one_name', label: 'Plus One Name', aliases: ['plus_one_name', 'plus one name', 'guest +1 name'] },
]

function autoDetectMapping(headers: string[]): Record<string, string> {
  const lower = headers.map(h => h.toLowerCase().trim())
  const map: Record<string, string> = {}
  for (const { key, aliases } of SCHEMA_FIELDS) {
    for (const alias of aliases) {
      const idx = lower.indexOf(alias)
      if (idx !== -1) { map[key] = headers[idx]; break }
    }
  }
  return map
}

// ─── Modal Wrapper ─────────────────────────────────────────────────────────────

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
  wide?: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={`bg-white dark:bg-zinc-900 rounded-xl shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 rounded p-0.5"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function GuestsPage() {
  // Data
  const [guests, setGuests] = useState<Guest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters & sort
  const [search, setSearch] = useState('')
  const [rsvpFilter, setRsvpFilter] = useState<RsvpStatus | 'all'>('all')
  const [sort, setSort] = useState<{ field: SortField; dir: SortDir }>({ field: 'name', dir: 'asc' })

  // Modals
  const [modal, setModal] = useState<ModalState>({ type: 'closed' })

  // Form state (add/edit)
  const [draft, setDraft] = useState<GuestDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // CSV state
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([])
  const [csvMapping, setCsvMapping] = useState<Record<string, string>>({})
  const [csvImporting, setCsvImporting] = useState(false)
  const [csvStep, setCsvStep] = useState<'upload' | 'preview'>('upload')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchGuests = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase.from('guests').select('*').order('name')
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    setGuests(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchGuests() }, [fetchGuests])

  // ── Derived state ──────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let list = guests
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(g =>
        g.name.toLowerCase().includes(q) ||
        (g.email ?? '').toLowerCase().includes(q) ||
        (g.plus_one_name ?? '').toLowerCase().includes(q)
      )
    }
    if (rsvpFilter !== 'all') {
      list = list.filter(g => g.rsvp_status === rsvpFilter)
    }
    return [...list].sort((a, b) => {
      const av = String(a[sort.field] ?? '')
      const bv = String(b[sort.field] ?? '')
      const cmp = av.localeCompare(bv)
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [guests, search, rsvpFilter, sort])

  const stats = useMemo(() => ({
    total: guests.length,
    confirmed: guests.filter(g => g.rsvp_status === 'confirmed').length,
    pending: guests.filter(g => g.rsvp_status === 'pending').length,
    declined: guests.filter(g => g.rsvp_status === 'declined').length,
  }), [guests])

  // ── Helpers ────────────────────────────────────────────────────────────────

  const toggleSort = (field: SortField) => {
    setSort(prev =>
      prev.field === field
        ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'asc' }
    )
  }

  const sortIcon = (field: SortField) => {
    if (sort.field !== field) return <span className="ml-1 text-zinc-300 dark:text-zinc-600">↕</span>
    return <span className="ml-1">{sort.dir === 'asc' ? '↑' : '↓'}</span>
  }

  const closeModal = () => setModal({ type: 'closed' })

  // ── Add / Edit ─────────────────────────────────────────────────────────────

  const openAdd = () => {
    setDraft(EMPTY_DRAFT)
    setFormError(null)
    setModal({ type: 'add' })
  }

  const openEdit = (g: Guest) => {
    setDraft({
      name: g.name,
      email: g.email,
      rsvp_status: g.rsvp_status,
      dietary_restrictions: g.dietary_restrictions,
      plus_one: g.plus_one,
      plus_one_name: g.plus_one_name,
    })
    setFormError(null)
    setModal({ type: 'edit', guest: g })
  }

  const saveGuest = async () => {
    if (!draft.name.trim()) { setFormError('Name is required.'); return }
    setSaving(true)
    setFormError(null)
    const payload = { ...draft, name: draft.name.trim() }

    if (modal.type === 'add') {
      const { error } = await supabase.from('guests').insert([payload])
      if (error) { setFormError(error.message); setSaving(false); return }
    } else if (modal.type === 'edit') {
      const { error } = await supabase.from('guests').update(payload).eq('id', modal.guest.id)
      if (error) { setFormError(error.message); setSaving(false); return }
    }

    await fetchGuests()
    setSaving(false)
    closeModal()
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  const openDelete = (g: Guest) => setModal({ type: 'delete', guest: g })

  const confirmDelete = async () => {
    if (modal.type !== 'delete') return
    setSaving(true)
    await supabase.from('guests').delete().eq('id', modal.guest.id)
    await fetchGuests()
    setSaving(false)
    closeModal()
  }

  // ── RSVP cycle ─────────────────────────────────────────────────────────────

  const cycleRsvp = async (g: Guest) => {
    const next: RsvpStatus =
      g.rsvp_status === 'pending' ? 'confirmed'
      : g.rsvp_status === 'confirmed' ? 'declined'
      : 'pending'
    // Optimistic update
    setGuests(prev => prev.map(x => x.id === g.id ? { ...x, rsvp_status: next } : x))
    await supabase.from('guests').update({ rsvp_status: next }).eq('id', g.id)
  }

  // ── CSV import ─────────────────────────────────────────────────────────────

  const openCsv = () => {
    setCsvStep('upload')
    setCsvHeaders([])
    setCsvRows([])
    setCsvMapping({})
    setModal({ type: 'csv' })
  }

  const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const { headers, rows } = parseCsv(text)
      setCsvHeaders(headers)
      setCsvRows(rows)
      setCsvMapping(autoDetectMapping(headers))
      setCsvStep('preview')
    }
    reader.readAsText(file)
  }

  const importCsv = async () => {
    setCsvImporting(true)
    const toInsert = csvRows
      .map(row => {
        const plusRaw = (row[csvMapping.plus_one ?? ''] ?? '').toLowerCase()
        const statusRaw = (row[csvMapping.rsvp_status ?? ''] ?? '').toLowerCase()
        return {
          name: (row[csvMapping.name ?? ''] ?? '').trim(),
          email: row[csvMapping.email ?? '']?.trim() || null,
          rsvp_status: (['pending', 'confirmed', 'declined'].includes(statusRaw)
            ? statusRaw : 'pending') as RsvpStatus,
          dietary_restrictions: row[csvMapping.dietary_restrictions ?? '']?.trim() || null,
          plus_one: ['true', 'yes', '1'].includes(plusRaw),
          plus_one_name: row[csvMapping.plus_one_name ?? '']?.trim() || null,
        }
      })
      .filter(g => g.name.length > 0)

    if (toInsert.length > 0) {
      await supabase.from('guests').insert(toInsert)
    }
    await fetchGuests()
    setCsvImporting(false)
    closeModal()
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  const inputClass = 'w-full px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100'
  const btnPrimary = 'px-4 py-2 text-sm bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-lg hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed'
  const btnSecondary = 'px-4 py-2 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-sm text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
            >
              ← Home
            </Link>
            <span className="text-zinc-300 dark:text-zinc-700">/</span>
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Guests</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openCsv}
              className="px-3 py-1.5 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center gap-1.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Import CSV
            </button>
            <button
              onClick={openAdd}
              className="px-3 py-1.5 text-sm bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-lg hover:bg-zinc-700 dark:hover:bg-zinc-300 flex items-center gap-1"
            >
              + Add Guest
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">

        {/* ── Stats ───────────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total', value: stats.total, color: 'text-zinc-900 dark:text-zinc-100' },
            { label: 'Confirmed', value: stats.confirmed, color: 'text-green-600 dark:text-green-400' },
            { label: 'Pending', value: stats.pending, color: 'text-yellow-600 dark:text-yellow-400' },
            { label: 'Declined', value: stats.declined, color: 'text-red-600 dark:text-red-400' },
          ].map(s => (
            <div
              key={s.label}
              className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4 py-3"
            >
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-0.5">{s.label}</p>
              <p className={`text-2xl font-semibold ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* ── Filters ─────────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
              xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search guests…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {(['all', 'confirmed', 'pending', 'declined'] as const).map(status => (
              <button
                key={status}
                onClick={() => setRsvpFilter(status)}
                className={`px-3 py-1.5 text-sm rounded-lg capitalize transition-colors ${
                  rsvpFilter === status
                    ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                    : 'border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
        </div>

        {/* ── Table ───────────────────────────────────────────────────────────── */}
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-zinc-400 text-sm">Loading…</div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <p className="text-red-500 text-sm">{error}</p>
              <button onClick={fetchGuests} className="text-sm text-zinc-500 underline hover:text-zinc-700">Retry</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-2">
              <p className="text-zinc-400 text-sm">
                {guests.length === 0
                  ? 'No guests yet. Add one above or import from a CSV.'
                  : 'No guests match your search.'}
              </p>
              {guests.length === 0 && (
                <button onClick={openAdd} className="text-sm text-zinc-600 dark:text-zinc-400 underline hover:text-zinc-900 dark:hover:text-zinc-200">
                  Add your first guest
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50">
                    <th
                      className="px-4 py-3 text-left font-medium text-zinc-500 dark:text-zinc-400 cursor-pointer select-none hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap"
                      onClick={() => toggleSort('name')}
                    >
                      Name {sortIcon('name')}
                    </th>
                    <th
                      className="px-4 py-3 text-left font-medium text-zinc-500 dark:text-zinc-400 cursor-pointer select-none hover:text-zinc-900 dark:hover:text-zinc-100 hidden md:table-cell whitespace-nowrap"
                      onClick={() => toggleSort('email')}
                    >
                      Email {sortIcon('email')}
                    </th>
                    <th
                      className="px-4 py-3 text-left font-medium text-zinc-500 dark:text-zinc-400 cursor-pointer select-none hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap"
                      onClick={() => toggleSort('rsvp_status')}
                    >
                      RSVP {sortIcon('rsvp_status')}
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-zinc-500 dark:text-zinc-400 hidden lg:table-cell whitespace-nowrap">
                      Dietary
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-zinc-500 dark:text-zinc-400 hidden sm:table-cell whitespace-nowrap">
                      +1
                    </th>
                    <th className="px-4 py-3 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {filtered.map(g => (
                    <tr
                      key={g.id}
                      className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-zinc-900 dark:text-zinc-100">{g.name}</p>
                        {g.email && (
                          <p className="text-xs text-zinc-400 md:hidden mt-0.5">{g.email}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400 hidden md:table-cell">
                        {g.email ?? <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => cycleRsvp(g)}
                          title="Click to cycle RSVP status"
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset cursor-pointer ${RSVP_BADGE[g.rsvp_status]}`}
                        >
                          {RSVP_LABEL[g.rsvp_status]}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400 hidden lg:table-cell text-xs">
                        {g.dietary_restrictions || <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        {g.plus_one ? (
                          <span className="text-xs text-zinc-600 dark:text-zinc-300">
                            ✓{g.plus_one_name ? ` ${g.plus_one_name}` : ''}
                          </span>
                        ) : (
                          <span className="text-zinc-300 dark:text-zinc-600 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-0.5">
                          <button
                            onClick={() => openEdit(g)}
                            title="Edit guest"
                            className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => openDelete(g)}
                            title="Remove guest"
                            className="p-1.5 text-zinc-400 hover:text-red-500 rounded hover:bg-red-50 dark:hover:bg-red-950"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                              <path d="M10 11v6" /><path d="M14 11v6" />
                              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {filtered.length > 0 && (
          <p className="text-xs text-zinc-400 text-right">
            Showing {filtered.length} of {guests.length} guest{guests.length !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {/* ── Add / Edit Modal ─────────────────────────────────────────────────── */}
      {(modal.type === 'add' || modal.type === 'edit') && (
        <Modal
          title={modal.type === 'add' ? 'Add Guest' : 'Edit Guest'}
          onClose={closeModal}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Name <span className="text-red-400">*</span>
              </label>
              <input
                autoFocus
                type="text"
                value={draft.name}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') saveGuest() }}
                className={inputClass}
                placeholder="Full name"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Email</label>
              <input
                type="email"
                value={draft.email ?? ''}
                onChange={e => setDraft(d => ({ ...d, email: e.target.value || null }))}
                className={inputClass}
                placeholder="email@example.com"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">RSVP Status</label>
              <select
                value={draft.rsvp_status}
                onChange={e => setDraft(d => ({ ...d, rsvp_status: e.target.value as RsvpStatus }))}
                className={inputClass}
              >
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="declined">Declined</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Dietary Restrictions</label>
              <input
                type="text"
                value={draft.dietary_restrictions ?? ''}
                onChange={e => setDraft(d => ({ ...d, dietary_restrictions: e.target.value || null }))}
                className={inputClass}
                placeholder="e.g. vegetarian, nut allergy"
              />
            </div>

            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.plus_one}
                  onChange={e => setDraft(d => ({
                    ...d,
                    plus_one: e.target.checked,
                    plus_one_name: e.target.checked ? d.plus_one_name : null,
                  }))}
                  className="rounded"
                />
                <span className="text-sm text-zinc-700 dark:text-zinc-300">Bringing a plus one</span>
              </label>
            </div>

            {draft.plus_one && (
              <div>
                <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Plus One Name</label>
                <input
                  type="text"
                  value={draft.plus_one_name ?? ''}
                  onChange={e => setDraft(d => ({ ...d, plus_one_name: e.target.value || null }))}
                  className={inputClass}
                  placeholder="Partner's name"
                />
              </div>
            )}

            {formError && (
              <p className="text-xs text-red-500">{formError}</p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={closeModal} className={btnSecondary}>Cancel</button>
              <button onClick={saveGuest} disabled={saving} className={btnPrimary}>
                {saving ? 'Saving…' : modal.type === 'add' ? 'Add Guest' : 'Save Changes'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Delete Modal ─────────────────────────────────────────────────────── */}
      {modal.type === 'delete' && (
        <Modal title="Remove Guest" onClose={closeModal}>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-5">
            Are you sure you want to remove{' '}
            <strong className="text-zinc-900 dark:text-zinc-100">{modal.guest.name}</strong>?
            This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={closeModal} className={btnSecondary}>Cancel</button>
            <button
              onClick={confirmDelete}
              disabled={saving}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {saving ? 'Removing…' : 'Remove Guest'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── CSV Import Modal ─────────────────────────────────────────────────── */}
      {modal.type === 'csv' && (
        <Modal title="Import from CSV" onClose={closeModal} wide>
          {csvStep === 'upload' ? (
            <div className="space-y-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Upload a CSV with guest data. We'll auto-detect common column names (name, email, rsvp_status, dietary, plus_one).
              </p>
              <div
                className="border-2 border-dashed border-zinc-200 dark:border-zinc-700 rounded-xl p-10 text-center cursor-pointer hover:border-zinc-400 dark:hover:border-zinc-500 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <svg className="mx-auto text-zinc-300 dark:text-zinc-600 mb-3" xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">Click to upload a CSV file</p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                  Columns: name, email, rsvp_status, dietary_restrictions, plus_one, plus_one_name
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={handleCsvFile}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                <strong className="text-zinc-900 dark:text-zinc-100">{csvRows.length} rows</strong> detected.
                Map your CSV columns to guest fields below, then confirm the import.
              </p>

              {/* Column mapping */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SCHEMA_FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400 w-36 shrink-0">{label}</span>
                    <select
                      value={csvMapping[key] ?? ''}
                      onChange={e => setCsvMapping(m => ({ ...m, [key]: e.target.value }))}
                      className="flex-1 px-2 py-1.5 text-xs border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
                    >
                      <option value="">— skip —</option>
                      {csvHeaders.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {/* Preview table */}
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">Preview (first 5 rows)</p>
                <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-auto max-h-44">
                  <table className="w-full text-xs">
                    <thead className="bg-zinc-50 dark:bg-zinc-800 sticky top-0">
                      <tr>
                        {csvHeaders.map(h => (
                          <th key={h} className="px-3 py-2 text-left text-zinc-500 dark:text-zinc-400 font-medium whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {csvRows.slice(0, 5).map((row, i) => (
                        <tr key={i} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                          {csvHeaders.map(h => (
                            <td key={h} className="px-3 py-2 text-zinc-600 dark:text-zinc-300 whitespace-nowrap">
                              {row[h] || <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {csvRows.length > 5 && (
                  <p className="text-xs text-zinc-400 mt-1">…and {csvRows.length - 5} more rows</p>
                )}
              </div>

              {!csvMapping.name && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  ⚠ Please map the Name column to continue.
                </p>
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                <button
                  onClick={() => {
                    setCsvStep('upload')
                    if (fileInputRef.current) fileInputRef.current.value = ''
                  }}
                  className={btnSecondary}
                >
                  ← Back
                </button>
                <div className="flex gap-2">
                  <button onClick={closeModal} className={btnSecondary}>Cancel</button>
                  <button
                    onClick={importCsv}
                    disabled={csvImporting || !csvMapping.name}
                    className={btnPrimary}
                  >
                    {csvImporting ? 'Importing…' : `Import ${csvRows.length} Guest${csvRows.length !== 1 ? 's' : ''}`}
                  </button>
                </div>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
