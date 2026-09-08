'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Smile } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  ETIQUETAS_PERSONALIDAD,
  textoPersonalidad,
} from '@/lib/claudia/prompt';

const NIVELES = [1, 2, 3, 4, 5] as const;
const MAX_EXTRA = 10_000;

export function ClaudiaPersonality({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Claudia.personality');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [personalidad, setPersonalidad] = useState(3);
  const [instruccionesExtra, setInstruccionesExtra] = useState('');
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/claudia/config');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setPersonalidad(data.personalidad ?? 3);
      setInstruccionesExtra(data.instrucciones_extra ?? '');
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/claudia/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalidad,
          instrucciones_extra: instruccionesExtra,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      setPersonalidad(data.personalidad);
      setInstruccionesExtra(data.instrucciones_extra ?? '');
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Smile className="h-4 w-4 text-primary" /> {t('levelLabel', { level: '' }).split(' ')[0]}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-5 gap-2">
          {NIVELES.map((n) => (
            <button
              key={n}
              type="button"
              disabled={disabled}
              onClick={() => setPersonalidad(n)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-md border px-2 py-2.5 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                personalidad === n
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="text-lg font-semibold tabular-nums">{n}</span>
              <span className="text-[11px] font-medium leading-tight">
                {ETIQUETAS_PERSONALIDAD[n]}
              </span>
            </button>
          ))}
        </div>

        {/* La descripción larga es el texto EXACTO que Claudia recibe en su
            prompt (en español, siempre — es como ella le habla al cliente).
            Se muestra tal cual para que el administrador sepa con precisión
            qué está pidiendo, en vez de adivinar a partir de la etiqueta. */}
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">
          {textoPersonalidad(personalidad)}
        </p>

        <div className="space-y-2">
          <Label htmlFor="claudia-extra">{t('extraLabel')}</Label>
          <Textarea
            id="claudia-extra"
            value={instruccionesExtra}
            onChange={(e) => setInstruccionesExtra(e.target.value.slice(0, MAX_EXTRA))}
            placeholder={t('extraPlaceholder')}
            rows={6}
            maxLength={MAX_EXTRA}
            disabled={disabled}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('extraHint')}</span>
            <span className="tabular-nums">
              {t('extraCount', { count: instruccionesExtra.length })}
            </span>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
