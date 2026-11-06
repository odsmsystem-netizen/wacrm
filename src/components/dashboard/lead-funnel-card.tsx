"use client"

import { Filter } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { LeadFunnelData } from '@/lib/dashboard/types'
import { pctOf } from '@/lib/dashboard/lead-funnel'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface LeadFunnelCardProps {
  data: LeadFunnelData | null
  loading: boolean
  days: number
}

export function LeadFunnelCard({ data, loading, days }: LeadFunnelCardProps) {
  const t = useTranslations('Dashboard.leadFunnel')

  const steps = data
    ? [
        { key: 'new', value: data.newConversations },
        { key: 'assigned', value: data.assigned },
        { key: 'deals', value: data.dealsCreated },
        { key: 'won', value: data.dealsWon },
      ]
    : []

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('description', { count: days })}
        </p>
      </header>

      <div className="p-5">
        {loading || !data ? (
          <Skeleton className="h-40 w-full" />
        ) : data.newConversations === 0 ? (
          <EmptyState icon={Filter} title={t('noData')} hint={t('noDataHint')} />
        ) : (
          <>
            <ul className="space-y-3">
              {steps.map(({ key, value }) => {
                const pct = pctOf(value, data.newConversations)
                return (
                  <li key={key} className="text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-foreground">{t(`steps.${key}`)}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {value.toLocaleString()} ({pct}%)
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>

            <dl className="mt-5 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">{t('hot')}</dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">
                  {data.qualification.hot}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('warm')}</dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">
                  {data.qualification.warm}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('cold')}</dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">
                  {data.qualification.cold}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('medianAssign')}</dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">
                  {data.medianMinutesToAssign == null
                    ? '—'
                    : t('minutes', { count: Math.round(data.medianMinutesToAssign) })}
                </dd>
              </div>
            </dl>
          </>
        )}
      </div>

      <footer className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        {t('note')}
      </footer>
    </section>
  )
}
