"use client"

import { Users } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ContactSourcesData } from '@/lib/dashboard/types'
import { sourceShares } from '@/lib/dashboard/contact-sources'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'
import { cn } from '@/lib/utils'

type RangeDays = 7 | 30 | 90

interface ContactSourcesCardProps {
  /** Datos por rango, para que cambiar de pestaña no vuelva a consultar. */
  data: Record<RangeDays, ContactSourcesData | null>
  loading: boolean
  range: RangeDays
  onRangeChange: (r: RangeDays) => void
}

type RowKey = 'whatsappOrganic' | 'whatsappAd' | 'whatsappPost' | 'messenger'

const ROWS: { key: RowKey; color: string }[] = [
  { key: 'whatsappOrganic', color: '#22c55e' },
  { key: 'whatsappAd', color: '#f59e0b' },
  { key: 'whatsappPost', color: '#a855f7' },
  { key: 'messenger', color: '#3b82f6' },
]

export function ContactSourcesCard({
  data,
  loading,
  range,
  onRangeChange,
}: ContactSourcesCardProps) {
  const t = useTranslations('Dashboard.contactSources')
  const current = data[range]

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          {[7, 30, 90].map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRangeChange(r as RangeDays)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                range === r
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('days', { count: r })}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-1 flex-col p-5">
        {loading || !current ? (
          <Skeleton className="h-40 w-full" />
        ) : current.total === 0 ? (
          <EmptyState icon={Users} title={t('noData')} hint={t('noDataHint')} />
        ) : (
          <Body data={current} t={t} />
        )}
      </div>

      <footer className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        {t('note')}
      </footer>
    </section>
  )
}

function Body({
  data,
  t,
}: {
  data: ContactSourcesData
  t: ReturnType<typeof useTranslations>
}) {
  const shares = sourceShares(data)
  // La fila de publicaciones solo aparece si hubo alguna.
  const rows = ROWS.filter((r) => r.key !== 'whatsappPost' || data.whatsappPost > 0)

  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums text-foreground">
          {data.total.toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground">{t('total')}</span>
      </div>
      <ul className="mt-4 space-y-3">
        {rows.map(({ key, color }) => {
          const count = data[key]
          const pct = shares[key]
          return (
            <li key={key} className="text-xs">
              <div className="flex items-center gap-3">
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{ background: color }}
                  aria-hidden
                />
                <span className="flex-1 truncate text-foreground">{t(key)}</span>
                <span className="font-medium tabular-nums text-foreground">
                  {count.toLocaleString()}
                </span>
                <span className="w-10 text-right tabular-nums text-muted-foreground">
                  {pct}%
                </span>
              </div>
              <div
                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={t('barLabel', { name: t(key), count, percent: pct })}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct}%`, background: color }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
