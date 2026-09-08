'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  BarChart3,
  CreditCard,
  Info,
  Loader2,
  PiggyBank,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { format, parseISO } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { BarChart } from '@/components/tremor/bar-chart';
import { pricingFor } from '@/lib/claudia/pricing';

const WINDOWS = [7, 30, 90] as const;

interface UsageResponse {
  dias: number;
  total_usd: number;
  tokens: {
    entrada: number;
    salida: number;
    cache_escritura: number;
    cache_lectura: number;
  };
  serie: { dia: string; usd: number; tokens: number }[];
  por_modelo: { modelo: string; usd: number; tokens: number }[];
  creditos: {
    cargado_usd: number;
    gastado_usd: number;
    restante_usd: number;
    ultima_recarga: string | null;
  } | null;
  truncated: boolean;
}

interface CreditRow {
  id: string;
  monto_usd: number;
  nota: string;
  recargado_en: string;
  creado: string;
}

function formatUsd(value: number): string {
  const v = Number(value) || 0;
  const digits = Math.abs(v) < 1 && v !== 0 ? 4 : 2;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Ahorro por caché: la API no reparte los tokens de caché por modelo,
 * así que se reparten aquí en proporción a la parte de cada modelo en
 * el consumo total, y se valora esa porción contra su propio precio de
 * entrada vs. lectura de caché. Un modelo sin precio conocido se
 * excluye de la suma (nunca se inventa un precio) y prende `unpriced`.
 */
function computeCacheSavings(data: UsageResponse): {
  savingsUsd: number;
  unpriced: boolean;
} {
  const totalTokens = data.por_modelo.reduce((s, m) => s + m.tokens, 0);
  if (totalTokens <= 0 || data.tokens.cache_lectura <= 0) {
    return { savingsUsd: 0, unpriced: false };
  }
  let savings = 0;
  let unpriced = false;
  for (const m of data.por_modelo) {
    const pricing = pricingFor(m.modelo);
    if (!pricing) {
      if (m.tokens > 0) unpriced = true;
      continue;
    }
    const share = m.tokens / totalTokens;
    const cacheReadTokens = data.tokens.cache_lectura * share;
    savings += (cacheReadTokens * (pricing.input - pricing.cacheRead)) / 1_000_000;
  }
  return { savingsUsd: savings, unpriced };
}

export function ClaudiaUsage({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Claudia.usage');
  const tRoot = useTranslations('Claudia');
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<UsageResponse | null>(null);
  const loadedRef = useRef<string | null>(null);

  const [credits, setCredits] = useState<CreditRow[]>([]);
  const [creditsLoading, setCreditsLoading] = useState(true);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeNote, setRechargeNote] = useState('');
  const [rechargeDate, setRechargeDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [submittingRecharge, setSubmittingRecharge] = useState(false);
  const [deletingCreditId, setDeletingCreditId] = useState<string | null>(null);

  const fetchUsage = useCallback(
    async (windowDays: number) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/claudia/usage?days=${windowDays}`, {
          cache: 'no-store',
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(json.error ?? t('loadFailed'));
          setData(null);
          return;
        }
        setData(json as UsageResponse);
      } catch {
        toast.error(t('loadFailed'));
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  const fetchCredits = useCallback(async () => {
    setCreditsLoading(true);
    try {
      const res = await fetch('/api/claudia/credits', { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('historyLoadFailed'));
        return;
      }
      setCredits((json.credits as CreditRow[]) ?? []);
    } catch {
      toast.error(t('historyLoadFailed'));
    } finally {
      setCreditsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || !canEdit) return;
    const key = `${accountId}:${days}`;
    if (loadedRef.current === key) return;
    loadedRef.current = key;
    void fetchUsage(days);
    void fetchCredits();
  }, [accountId, canEdit, days, fetchUsage, fetchCredits]);

  const handleRecharge = async () => {
    const monto = Number(rechargeAmount);
    if (!Number.isFinite(monto) || monto <= 0) {
      toast.error(t('rechargeDialog.invalidAmount'));
      return;
    }
    setSubmittingRecharge(true);
    try {
      const res = await fetch('/api/claudia/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monto_usd: monto,
          nota: rechargeNote.trim() || undefined,
          recargado_en: new Date(rechargeDate).toISOString(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('rechargeDialog.failed'));
        return;
      }
      toast.success(t('rechargeDialog.success'));
      setRechargeOpen(false);
      setRechargeAmount('');
      setRechargeNote('');
      setRechargeDate(new Date().toISOString().slice(0, 10));
      await Promise.all([fetchUsage(days), fetchCredits()]);
    } catch {
      toast.error(t('rechargeDialog.failed'));
    } finally {
      setSubmittingRecharge(false);
    }
  };

  const handleDeleteRecharge = async (id: string) => {
    if (!window.confirm(t('deleteRechargeConfirm'))) return;
    setDeletingCreditId(id);
    try {
      const res = await fetch(`/api/claudia/credits/${id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('deleteRechargeFailed'));
        return;
      }
      toast.success(t('deleteRechargeSuccess'));
      await Promise.all([fetchUsage(days), fetchCredits()]);
    } catch {
      toast.error(t('deleteRechargeFailed'));
    } finally {
      setDeletingCreditId(null);
    }
  };

  if (!canEdit) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {tRoot('adminOnlyEdit')}
      </p>
    );
  }

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  const hasActivity =
    data.total_usd > 0 ||
    data.tokens.entrada + data.tokens.salida + data.tokens.cache_escritura + data.tokens.cache_lectura > 0;

  const { savingsUsd, unpriced } = computeCacheSavings(data);

  const chartData = data.serie.map((d) => ({
    day: format(parseISO(d.dia), 'MMM d'),
    USD: d.usd,
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((w) => (
              <SelectItem key={w} value={String(w)}>
                {t(w === 7 ? 'window7' : w === 30 ? 'window30' : 'window90')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CreditCard className="h-3.5 w-3.5" /> {t('credits.title')}
            </p>
            {data.creditos ? (
              <>
                <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                  {formatUsd(data.creditos.restante_usd)}
                </p>
                {data.creditos.ultima_recarga && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('credits.lastRecharge', {
                      date: formatDate(data.creditos.ultima_recarga),
                    })}
                  </p>
                )}
                <p className="mt-2 flex items-start gap-1.5 rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  {t('credits.estimateNotice')}
                </p>
              </>
            ) : (
              <div className="mt-1 space-y-2">
                <p className="text-sm font-medium text-foreground">
                  {t('credits.emptyTitle')}
                </p>
                <p className="text-xs text-muted-foreground">{t('credits.emptyBody')}</p>
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              className="mt-3 w-full"
              onClick={() => setRechargeOpen(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t('credits.register')}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <BarChart3 className="h-3.5 w-3.5" /> {t('spend.title')}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
              {formatUsd(data.total_usd)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('spend.window', { days: data.dias })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <PiggyBank className="h-3.5 w-3.5" /> {t('cacheSavings.title')}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
              {formatUsd(savingsUsd)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('cacheSavings.description')}
            </p>
            {unpriced && (
              <p className="mt-1 text-[11px] text-amber-500">{t('cacheSavings.unpriced')}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {!hasActivity ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <TokenStat label={t('tokens.input')} value={data.tokens.entrada} />
            <TokenStat label={t('tokens.output')} value={data.tokens.salida} />
            <TokenStat label={t('tokens.cacheWrite')} value={data.tokens.cache_escritura} />
            <TokenStat label={t('tokens.cacheRead')} value={data.tokens.cache_lectura} />
          </div>

          <Card>
            <CardHeader>
              <CardDescription>{t('dailyChart')}</CardDescription>
            </CardHeader>
            <CardContent>
              <BarChart
                data={chartData}
                index="day"
                categories={['USD']}
                colors={['violet']}
                valueFormatter={(v) => formatUsd(v)}
                showLegend={false}
                yAxisWidth={56}
                className="h-[220px]"
              />
            </CardContent>
          </Card>

          {data.por_modelo.length > 0 && (
            <Card>
              <CardHeader>
                <CardDescription>{t('byModel')}</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {data.por_modelo.map((m) => (
                    <li
                      key={m.modelo}
                      className="flex items-center justify-between px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate text-foreground">{m.modelo}</span>
                      <span className="flex-shrink-0 tabular-nums text-muted-foreground">
                        {formatUsd(m.usd)} · {m.tokens.toLocaleString()} tok
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {data.truncated && (
            <p className="text-xs text-muted-foreground">{t('truncated')}</p>
          )}
        </>
      )}

      <Card>
        <CardHeader>
          <CardDescription>{t('history')}</CardDescription>
        </CardHeader>
        <CardContent>
          {creditsLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : credits.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('historyEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {credits.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium tabular-nums text-foreground">
                      {formatUsd(c.monto_usd)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatDate(c.recargado_en)}
                      {c.nota ? ` · ${c.nota}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!canEdit || deletingCreditId === c.id}
                    onClick={() => handleDeleteRecharge(c.id)}
                    className="shrink-0 text-destructive hover:bg-destructive/10"
                  >
                    {deletingCreditId === c.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={rechargeOpen} onOpenChange={setRechargeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('rechargeDialog.title')}</DialogTitle>
            <DialogDescription>{t('rechargeDialog.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="claudia-recharge-amount">{t('rechargeDialog.amountLabel')}</Label>
              <Input
                id="claudia-recharge-amount"
                type="number"
                min="0"
                step="0.01"
                value={rechargeAmount}
                onChange={(e) => setRechargeAmount(e.target.value)}
                disabled={submittingRecharge}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="claudia-recharge-note">{t('rechargeDialog.noteLabel')}</Label>
              <Input
                id="claudia-recharge-note"
                value={rechargeNote}
                onChange={(e) => setRechargeNote(e.target.value)}
                disabled={submittingRecharge}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="claudia-recharge-date">{t('rechargeDialog.dateLabel')}</Label>
              <Input
                id="claudia-recharge-date"
                type="date"
                value={rechargeDate}
                onChange={(e) => setRechargeDate(e.target.value)}
                disabled={submittingRecharge}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRechargeOpen(false)}
              disabled={submittingRecharge}
            >
              {t('rechargeDialog.cancel')}
            </Button>
            <Button onClick={handleRecharge} disabled={submittingRecharge}>
              {submittingRecharge && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {submittingRecharge ? t('rechargeDialog.submitting') : t('rechargeDialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TokenStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

