'use client'

/**
 * TSK-16: Migrate food tasting app to wedding repo
 *
 * Place this file at: src/app/food/page.tsx
 *
 * Required Supabase tables (same "Food" project — no migration needed for data):
 *
 *   food_options (
 *     id          text primary key,
 *     category    text,          -- 'CARNE' | 'PISCES' | 'VEGETUS'
 *     name        text,
 *     subtitle    text,
 *     score       int,
 *     recommended boolean default false,
 *     skip        boolean default false,
 *     commentary  text
 *   )
 *
 *   food_selections (
 *     id          text primary key,  -- use 'shared' as the single shared row
 *     order_ids   text[],            -- food_option ids in ranked order
 *     selected_ids text[],           -- the chosen 5
 *     updated_at  timestamptz
 *   )
 *
 * If food_options is empty on first load, the hardcoded tasting list below
 * is used as a fallback so the page always works.
 *
 * The shared `guests` table is queried to display collaborator names in the
 * live-sync status indicator (shows "Live · shared with <name>").
 *
 * Features:
 *   - Drag-and-drop ranking of canapé options
 *   - Select up to 5 favorites
 *   - Real-time sync via Supabase Realtime
 *   - Category filter (Tout / Viandes / Poissons / Légumes)
 *   - Inline commentary on expand
 *   - Star score display
 *   - Synced-at timestamp
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

type FoodOption = {
  id: string
  category: 'CARNE' | 'PISCES' | 'VEGETUS'
  name: string
  subtitle?: string | null
  score: number
  recommended: boolean
  skip?: boolean
  commentary?: string | null
}

type Category = 'ALL' | 'CARNE' | 'PISCES' | 'VEGETUS'

// ─── Hardcoded fallback data (used if food_options table is empty) ─────────────

const FALLBACK_FOOD_OPTIONS: FoodOption[] = [
  {
    id: 'pate-croute',
    category: 'CARNE',
    name: 'Pâté en Croûte',
    subtitle: 'Convivium Signature',
    score: 5,
    recommended: true,
    commentary:
      'The signature dish — this is the one you try no matter what. Classically French, unpretentious in the best way. Not trying to be clever. Just very good.',
  },
  {
    id: 'truffle-croque',
    category: 'CARNE',
    name: 'Truffle Croque',
    subtitle: null,
    score: 3,
    recommended: false,
    commentary:
      'Luxurious and crowd-pleasing. Very French. Slightly richer register than the rest of the shortlist, but hard to argue with at a château wedding.',
  },
  {
    id: 'rillettes',
    category: 'CARNE',
    name: 'Black Pepper Rillettes, Pear & Spices',
    subtitle: null,
    score: 3,
    recommended: false,
    commentary:
      'Rustic and beautiful — perfect for a garden setting. The pear and spice lift it out of bistro territory. A strong contender if you want something earthy.',
  },
  {
    id: 'beaufort',
    category: 'CARNE',
    name: 'Beaufort Chantilly & Bacon Powder',
    subtitle: null,
    score: 2,
    recommended: false,
    commentary:
      'Interesting technique. The Beaufort gives it Alpine soul. A bit more cerebral than the others.',
  },
  {
    id: 'chorizo',
    category: 'CARNE',
    name: 'Chorizo, Piperade & Fresh Herbs',
    subtitle: null,
    score: 2,
    recommended: false,
    commentary:
      'More Basque than Alpine. Bold, rustic flavours — good but might clash tonally with the lakeside elegance you\'re going for.',
  },
  {
    id: 'pork-onion',
    category: 'CARNE',
    name: 'Pork & Onion Confit',
    subtitle: null,
    score: 1,
    recommended: false,
    commentary:
      'Solid and approachable. Crowd-pleaser territory. Doesn\'t particularly distinguish itself but won\'t divide opinion either.',
  },
  {
    id: 'pepper-bread',
    category: 'CARNE',
    name: 'Pepper Bread, Mortadella, Ricotta, Figs & Pickles',
    subtitle: null,
    score: 2,
    recommended: false,
    commentary:
      'Fun, deli-adjacent. The figs and pickles give it some personality. Slightly Italian in register — not unwelcome, but less distinctly French.',
  },
  {
    id: 'pastrami',
    category: 'CARNE',
    name: 'Pastrami Cheddar Millefeuille',
    subtitle: 'Sweet & Sour Sauce',
    score: 0,
    recommended: false,
    skip: true,
    commentary:
      'This is New York deli energy. Delicious in the right context — but that context isn\'t a French château lakeside wedding.',
  },
  {
    id: 'yuzu-salmon',
    category: 'PISCES',
    name: 'Yuzu Kosho Cream, Salmon & Roe',
    subtitle: null,
    score: 5,
    recommended: true,
    commentary:
      'Elegant and celebratory. The yuzu reads Japanese-European rather than American — sophisticated without being fussy. The roe makes it feel like an occasion.',
  },
  {
    id: 'haddock',
    category: 'PISCES',
    name: 'Smoked Haddock, Hazelnut & Lemon Balm',
    subtitle: 'Espuma',
    score: 5,
    recommended: true,
    commentary:
      'The most interesting fish option. Delicate, herby, distinctly European aperitif energy. The kind of thing you don\'t forget.',
  },
  {
    id: 'tempura-shrimp',
    category: 'PISCES',
    name: 'Tempura Shrimp & Black Lemon',
    subtitle: null,
    score: 3,
    recommended: false,
    commentary:
      'Safe but genuinely loved. The black lemon adds character. Good insurance option if you want broad appeal.',
  },
  {
    id: 'octopus',
    category: 'PISCES',
    name: 'Octopus Baba',
    subtitle: null,
    score: 2,
    recommended: false,
    commentary:
      'Creative and unexpected. Could be extraordinary or divisive — octopus at a canapé is a bold call. Worth tasting with curiosity.',
  },
  {
    id: 'crab-roll',
    category: 'PISCES',
    name: 'Crab Roll, Chinata Dolce & Fresh Herbs',
    subtitle: null,
    score: 1,
    recommended: false,
    skip: true,
    commentary:
      'Skews American casual. The \'roll\' format is the giveaway. Good flavours but wrong register for the aesthetic you\'re after.',
  },
  {
    id: 'salmon-maki',
    category: 'PISCES',
    name: 'Smoked Salmon Maki, Candied Ginger & Wasabi Crunch',
    subtitle: 'Spicy Japanese Mayo',
    score: 0,
    recommended: false,
    skip: true,
    commentary:
      'The spicy mayo is the problem — it\'s Brooklyn brunch, not Annecy lakeside.',
  },
  {
    id: 'cervelle',
    category: 'VEGETUS',
    name: 'Cervelle de Canut',
    subtitle: 'With Sea Notes',
    score: 5,
    recommended: true,
    commentary:
      'Lyon\'s most beloved cheese preparation. Herbaceous, fresh, deeply local. Having this at a wedding in the French Alps is just right — it places you somewhere specific.',
  },
  {
    id: 'cauliflower',
    category: 'VEGETUS',
    name: 'Cauliflower, Madras Curry & Elderflower',
    subtitle: null,
    score: 5,
    recommended: true,
    commentary:
      'The most adventurous vegetable option by a distance. This is what farm-to-table confidence looks like — a humble ingredient elevated by technique and unexpected pairing.',
  },
  {
    id: 'three-peas',
    category: 'VEGETUS',
    name: 'Three Little Peas',
    subtitle: null,
    score: 3,
    recommended: false,
    commentary:
      'Intriguing name — probably a playful spring preparation. Garden-fresh and on-brand for your aesthetic. Worth tasting.',
  },
  {
    id: 'camembert',
    category: 'VEGETUS',
    name: 'Camembert & Onion',
    subtitle: null,
    score: 2,
    recommended: false,
    commentary:
      'Crowd-pleasing and very French. A safe veg option if you want something universally accessible.',
  },
  {
    id: 'gingerbread',
    category: 'VEGETUS',
    name: 'Gingerbread, Onion Confit, Milk & Chili',
    subtitle: null,
    score: 2,
    recommended: false,
    commentary:
      'Unexpected sweet-savoury combination. Could be lovely — the chili heat is a surprise. Divisive but memorable.',
  },
  {
    id: 'cucumber',
    category: 'VEGETUS',
    name: 'Cucumber & Combava Lime Maki',
    subtitle: null,
    score: 1,
    recommended: false,
    commentary:
      'Light and palate-cleansing. The kaffir lime is a nice touch. Simple but might feel slight next to the others.',
  },
]

const CATEGORY_META: Record<
  Exclude<Category, 'ALL'>,
  { label: string; color: string }
> = {
  CARNE: { label: 'Viandes', color: '#7a3b1e' },
  PISCES: { label: 'Poissons', color: '#1a4a6e' },
  VEGETUS: { label: 'Légumes', color: '#2d5a3e' },
}

// ─── StarScore ────────────────────────────────────────────────────────────────

function StarScore({ score }: { score: number }) {
  return (
    <span style={{ letterSpacing: 1, fontSize: 10 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          style={{
            color: n <= score ? '#c9a96e' : '#ddd',
            opacity: n <= score ? 1 : 0.35,
          }}
        >
          ★
        </span>
      ))}
    </span>
  )
}

// ─── FoodPage ─────────────────────────────────────────────────────────────────

export default function FoodPage() {
  const [foodOptions, setFoodOptions] = useState<FoodOption[]>([])
  const [order, setOrder] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [category, setCategory] = useState<Category>('ALL')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [lastSynced, setLastSynced] = useState<string | null>(null)
  const [collaboratorName, setCollaboratorName] = useState<string>('Andrea')
  const [loaded, setLoaded] = useState(false)
  const suppressRealtime = useRef(false)

  // ── Load food options from Supabase (fallback to hardcoded) ───────────────

  useEffect(() => {
    async function loadOptions() {
      const { data, error } = await supabase
        .from('food_options')
        .select('*')
        .order('category')

      const options =
        !error && data && data.length > 0
          ? (data as FoodOption[])
          : FALLBACK_FOOD_OPTIONS

      setFoodOptions(options)
      return options
    }

    async function loadState(options: FoodOption[]) {
      const { data } = await supabase
        .from('food_selections')
        .select('order_ids, selected_ids, updated_at')
        .eq('id', 'shared')
        .single()

      const defaultOrder = options.map((o) => o.id)
      const defaultSelected = new Set(
        options.filter((o) => o.recommended).map((o) => o.id)
      )

      if (data?.order_ids?.length) {
        setOrder(data.order_ids)
      } else {
        setOrder(defaultOrder)
      }

      if (data?.selected_ids?.length) {
        setSelected(new Set(data.selected_ids))
      } else {
        setSelected(defaultSelected)
      }

      if (data?.updated_at) setLastSynced(data.updated_at)
      setLoaded(true)
    }

    loadOptions().then(loadState)
  }, [])

  // ── Load collaborator name from guests table ───────────────────────────────

  useEffect(() => {
    async function loadCollaborator() {
      const { data } = await supabase
        .from('guests')
        .select('name')
        .limit(5)

      // Show the first guest name that isn't Markus as the collaborator
      if (data && data.length > 0) {
        const other = data.find(
          (g: { name: string }) =>
            !g.name.toLowerCase().includes('markus') &&
            !g.name.toLowerCase().includes('fischer')
        )
        if (other) setCollaboratorName(other.name.split(' ')[0])
      }
    }
    loadCollaborator()
  }, [])

  // ── Real-time subscription ────────────────────────────────────────────────

  useEffect(() => {
    if (!loaded) return

    const channel = supabase
      .channel('food-realtime')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'food_selections',
          filter: 'id=eq.shared',
        },
        (payload) => {
          if (suppressRealtime.current) return
          const row = payload.new as {
            order_ids?: string[]
            selected_ids?: string[]
            updated_at?: string
          }
          if (row.order_ids?.length) setOrder(row.order_ids)
          if (row.selected_ids?.length) setSelected(new Set(row.selected_ids))
          if (row.updated_at) setLastSynced(row.updated_at)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [loaded])

  // ── Persist to Supabase ───────────────────────────────────────────────────

  const persist = useCallback(
    async (newOrder: string[], newSelected: Set<string>) => {
      setSyncing(true)
      suppressRealtime.current = true
      const updatedAt = new Date().toISOString()

      await supabase.from('food_selections').upsert({
        id: 'shared',
        order_ids: newOrder,
        selected_ids: [...newSelected],
        updated_at: updatedAt,
      })

      setLastSynced(updatedAt)
      setSyncing(false)
      setTimeout(() => {
        suppressRealtime.current = false
      }, 500)
    },
    []
  )

  // ── Drag handlers ─────────────────────────────────────────────────────────

  const handleDrop = useCallback(
    (targetId: string) => {
      if (!draggingId || draggingId === targetId) {
        setDraggingId(null)
        setDragOverId(null)
        return
      }
      const fromIdx = order.indexOf(draggingId)
      const toIdx = order.indexOf(targetId)
      const next = [...order]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      setOrder(next)
      persist(next, selected)
      setDraggingId(null)
      setDragOverId(null)
    },
    [draggingId, order, selected, persist]
  )

  const moveItem = useCallback(
    (id: string, dir: 'up' | 'down') => {
      const idx = order.indexOf(id)
      if (dir === 'up' && idx === 0) return
      if (dir === 'down' && idx === order.length - 1) return
      const next = [...order]
      const swapIdx = dir === 'up' ? idx - 1 : idx + 1
      ;[next[idx], next[swapIdx]] = [next[swapIdx], next[idx]]
      setOrder(next)
      persist(next, selected)
    },
    [order, selected, persist]
  )

  const toggleSelect = useCallback(
    (id: string) => {
      const next = new Set(selected)
      if (next.has(id)) {
        next.delete(id)
      } else {
        if (next.size >= 5) return
        next.add(id)
      }
      setSelected(next)
      persist(order, next)
    },
    [selected, order, persist]
  )

  // ── Derived state ─────────────────────────────────────────────────────────

  const optionMap = Object.fromEntries(foodOptions.map((o) => [o.id, o]))
  const orderedOptions = order.map((id) => optionMap[id]).filter(Boolean)
  const filteredOptions =
    category === 'ALL'
      ? orderedOptions
      : orderedOptions.filter((o) => o.category === category)

  const syncLabel = (() => {
    if (!lastSynced) return null
    const secs = Math.floor((Date.now() - new Date(lastSynced).getTime()) / 1000)
    if (secs < 10) return 'just now'
    if (secs < 60) return `${secs}s ago`
    return `${Math.floor(secs / 60)}m ago`
  })()

  // ── Loading state ─────────────────────────────────────────────────────────

  if (!loaded) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#f5f0e8',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p
          style={{
            fontFamily: "Georgia,'Times New Roman',serif",
            color: '#9e8c6e',
            fontStyle: 'italic',
          }}
        >
          Chargement…
        </p>
      </div>
    )
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f5f0e8',
        fontFamily: "Georgia,'Times New Roman',serif",
        color: '#2c2416',
        paddingBottom: selected.size > 0 ? 110 : 32,
      }}
    >
      {/* ── Header (wedding app style) ── */}
      <header className="shrink-0 border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 flex items-center gap-4 bg-white dark:bg-black font-sans">
        <Link
          href="/"
          className="text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 text-sm transition-colors"
        >
          ← Home
        </Link>
        <h1 className="text-xl font-semibold text-black dark:text-white">
          Food Tasting
        </h1>
        <span className="text-sm text-zinc-400 dark:text-zinc-500">
          Château de Duingt · Canapés
        </span>
      </header>

      {/* ── Hero / tasting header ── */}
      <div
        style={{
          background:
            'linear-gradient(135deg,#2c4a3e 0%,#1a3329 60%,#0f2219 100%)',
          padding: '40px 24px 30px',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'radial-gradient(circle at 20% 80%,rgba(201,169,110,.12) 0%,transparent 60%),radial-gradient(circle at 80% 20%,rgba(201,169,110,.08) 0%,transparent 50%)',
          }}
        />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <p
            style={{
              color: '#c9a96e',
              letterSpacing: '.25em',
              fontSize: 10,
              textTransform: 'uppercase',
              margin: '0 0 10px',
            }}
          >
            Château de Duingt · Tasting
          </p>
          <h2
            style={{
              color: '#f5f0e8',
              fontSize: 'clamp(22px,5vw,36px)',
              fontWeight: 'normal',
              margin: '0 0 6px',
              lineHeight: 1.1,
            }}
          >
            Le Menu de Réception
          </h2>
          <p
            style={{
              color: 'rgba(245,240,232,.5)',
              fontSize: 13,
              margin: '0 0 22px',
              fontStyle: 'italic',
            }}
          >
            Drag, rank, and choose your five
          </p>

          {/* Sync indicator */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              marginBottom: 18,
            }}
          >
            <div
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: syncing ? '#f0c040' : '#5cb85c',
                boxShadow: `0 0 6px ${syncing ? '#f0c040' : '#5cb85c'}`,
                transition: 'all .3s',
              }}
            />
            <span
              style={{
                color: 'rgba(245,240,232,.55)',
                fontSize: 11,
                letterSpacing: '.06em',
              }}
            >
              {syncing
                ? 'Syncing…'
                : syncLabel
                ? `Synced ${syncLabel} · live with ${collaboratorName}`
                : `Live · shared with ${collaboratorName}`}
            </span>
          </div>

          {/* Selection counter */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              background: 'rgba(245,240,232,.08)',
              border: '1px solid rgba(201,169,110,.3)',
              borderRadius: 32,
              padding: '9px 20px',
            }}
          >
            <div style={{ display: 'flex', gap: 5 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <div
                  key={n}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background:
                      n <= selected.size
                        ? '#c9a96e'
                        : 'rgba(201,169,110,.2)',
                    transition: 'background .3s',
                  }}
                />
              ))}
            </div>
            <span
              style={{
                color:
                  selected.size === 5
                    ? '#c9a96e'
                    : 'rgba(245,240,232,.65)',
                fontSize: 12,
                letterSpacing: '.05em',
              }}
            >
              {selected.size === 5
                ? 'Selection complete ✓'
                : `${selected.size} of 5 selected`}
            </span>
          </div>
        </div>
      </div>

      {/* ── Category filter ── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 6,
          padding: '16px 16px 0',
          flexWrap: 'wrap',
        }}
      >
        {(['ALL', 'CARNE', 'PISCES', 'VEGETUS'] as Category[]).map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            style={{
              padding: '6px 15px',
              borderRadius: 20,
              border:
                category === cat
                  ? '1px solid #2c4a3e'
                  : '1px solid #d4c9b8',
              background: category === cat ? '#2c4a3e' : 'transparent',
              color: category === cat ? '#f5f0e8' : '#6b5a3e',
              fontSize: 11,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              fontFamily: "Georgia,serif",
              transition: 'all .2s',
            }}
          >
            {cat === 'ALL' ? 'Tout' : CATEGORY_META[cat].label}
          </button>
        ))}
      </div>

      <p
        style={{
          textAlign: 'center',
          color: '#b0a08a',
          fontSize: 11,
          margin: '9px 0 2px',
          fontStyle: 'italic',
        }}
      >
        Drag to reorder · tap to expand · ✓ to select
      </p>

      {/* ── Food list ── */}
      <div
        style={{ maxWidth: 620, margin: '10px auto 0', padding: '0 12px' }}
      >
        {filteredOptions.map((item) => {
          const rank = orderedOptions.indexOf(item) + 1
          const isSelected = selected.has(item.id)
          const isExpanded = expandedId === item.id

          return (
            <div
              key={item.id}
              draggable
              onDragStart={() => setDraggingId(item.id)}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverId(item.id)
              }}
              onDrop={() => handleDrop(item.id)}
              onDragEnd={() => {
                setDraggingId(null)
                setDragOverId(null)
              }}
              style={{
                marginBottom: 7,
                borderRadius: 10,
                border: isSelected
                  ? '1.5px solid #2c4a3e'
                  : dragOverId === item.id
                  ? '1.5px dashed #c9a96e'
                  : '1px solid #ddd5c8',
                background: isSelected
                  ? 'rgba(44,74,62,.045)'
                  : item.skip
                  ? 'rgba(0,0,0,.015)'
                  : '#fff',
                opacity:
                  draggingId === item.id ? 0.3 : item.skip ? 0.5 : 1,
                transition: 'all .15s',
                cursor: 'grab',
                transform:
                  dragOverId === item.id ? 'scale(1.012)' : 'scale(1)',
              }}
            >
              {/* Item row */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 13px',
                  cursor: 'pointer',
                }}
                onClick={() => setExpandedId(isExpanded ? null : item.id)}
              >
                {/* Rank badge */}
                <div
                  style={{
                    width: 23,
                    height: 23,
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '50%',
                    background:
                      rank <= 5 ? '#2c4a3e' : 'rgba(0,0,0,.07)',
                    color: rank <= 5 ? '#c9a96e' : '#9e8c6e',
                    fontSize: 10,
                    fontWeight: 'bold',
                  }}
                >
                  {rank}
                </div>

                {/* Category dot */}
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: CATEGORY_META[item.category].color,
                    flexShrink: 0,
                    opacity: 0.65,
                  }}
                />

                {/* Name + score */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: item.recommended ? 'bold' : 'normal',
                        color: item.skip ? '#9e8c6e' : '#2c2416',
                      }}
                    >
                      {item.name}
                    </span>
                    {item.subtitle && (
                      <span
                        style={{
                          fontSize: 10,
                          color: '#a0907a',
                          fontStyle: 'italic',
                        }}
                      >
                        {item.subtitle}
                      </span>
                    )}
                    {item.recommended && (
                      <span
                        style={{
                          fontSize: 9,
                          color: '#2c4a3e',
                          background: 'rgba(44,74,62,.1)',
                          padding: '1px 5px',
                          borderRadius: 5,
                          letterSpacing: '.07em',
                          textTransform: 'uppercase',
                        }}
                      >
                        Rec.
                      </span>
                    )}
                    {item.skip && (
                      <span
                        style={{
                          fontSize: 9,
                          color: '#8b4513',
                          background: 'rgba(139,69,19,.1)',
                          padding: '1px 5px',
                          borderRadius: 5,
                          letterSpacing: '.07em',
                          textTransform: 'uppercase',
                        }}
                      >
                        Skip
                      </span>
                    )}
                  </div>
                  <StarScore score={item.score} />
                </div>

                {/* Up/down buttons */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    flexShrink: 0,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {(['up', 'down'] as const).map((dir) => (
                    <button
                      key={dir}
                      onClick={() => moveItem(item.id, dir)}
                      style={{
                        width: 19,
                        height: 19,
                        border: '1px solid #ddd',
                        background: 'transparent',
                        borderRadius: 3,
                        cursor: 'pointer',
                        color: '#a0907a',
                        fontSize: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {dir === 'up' ? '▲' : '▼'}
                    </button>
                  ))}
                </div>

                {/* Select button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleSelect(item.id)
                  }}
                  style={{
                    width: 25,
                    height: 25,
                    borderRadius: '50%',
                    flexShrink: 0,
                    border: isSelected ? 'none' : '1.5px solid #d4c9b8',
                    background: isSelected ? '#2c4a3e' : 'transparent',
                    color: isSelected ? '#c9a96e' : '#c0b8a8',
                    fontSize: 11,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all .2s',
                  }}
                >
                  ✓
                </button>
              </div>

              {/* Expanded commentary */}
              {isExpanded && item.commentary && (
                <div
                  style={{
                    padding: '0 13px 13px 52px',
                    borderTop: '1px solid #ede7d9',
                  }}
                >
                  <p
                    style={{
                      margin: '10px 0 0',
                      fontSize: 12,
                      color: '#5a4a32',
                      lineHeight: 1.75,
                      fontStyle: 'italic',
                    }}
                  >
                    &ldquo;{item.commentary}&rdquo;
                  </p>
                  <p
                    style={{
                      margin: '6px 0 0',
                      fontSize: 10,
                      color: '#a0907a',
                      letterSpacing: '.07em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {CATEGORY_META[item.category].label}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Fixed selection bar ── */}
      {selected.size > 0 && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'linear-gradient(to top,#1a3329,#2c4a3e)',
            borderTop: '1px solid rgba(201,169,110,.25)',
            padding: '12px 18px',
          }}
        >
          <div style={{ maxWidth: 620, margin: '0 auto' }}>
            <p
              style={{
                color: '#c9a96e',
                fontSize: 9,
                letterSpacing: '.2em',
                textTransform: 'uppercase',
                margin: '0 0 6px',
              }}
            >
              Votre sélection
            </p>
            <div
              style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}
            >
              {foodOptions
                .filter((o) => selected.has(o.id))
                .map((o) => (
                  <span
                    key={o.id}
                    style={{
                      background: 'rgba(245,240,232,.1)',
                      border: '1px solid rgba(201,169,110,.25)',
                      borderRadius: 12,
                      padding: '3px 9px',
                      color: '#f5f0e8',
                      fontSize: 11,
                    }}
                  >
                    {o.name}
                  </span>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}