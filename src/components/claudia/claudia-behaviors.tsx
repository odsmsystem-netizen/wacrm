'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Behavior {
  id: string;
  titulo: string;
  instruccion: string;
  activo: boolean;
  orden: number;
  creado: string;
}

interface Draft {
  id?: string;
  titulo: string;
  instruccion: string;
}

export function ClaudiaBehaviors({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Claudia.behaviors');
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Behavior[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const loadedAccountIdRef = useRef<string | null>(null);

  const setBusy = (id: string, val: boolean) =>
    setBusyIds((prev) => ({ ...prev, [id]: val }));

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/claudia/behaviors');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setItems((data.behaviors as Behavior[]) ?? []);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchItems();
  }, [accountId, fetchItems]);

  const openCreate = () => setDraft({ titulo: '', instruccion: '' });
  const openEdit = (b: Behavior) =>
    setDraft({ id: b.id, titulo: b.titulo, instruccion: b.instruccion });

  const handleSave = async () => {
    if (!draft) return;
    if (!draft.titulo.trim() || !draft.instruccion.trim()) {
      toast.error(t('missingFields'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/claudia/behaviors/${draft.id}` : '/api/claudia/behaviors',
        {
          method: draft.id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            titulo: draft.titulo.trim(),
            instruccion: draft.instruccion.trim(),
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          data.error ?? (draft.id ? t('updateFailed') : t('createFailed')),
        );
        return;
      }
      toast.success(draft.id ? t('updateSuccess') : t('createSuccess'));
      setDraft(null);
      await fetchItems();
    } catch {
      toast.error(draft.id ? t('updateFailed') : t('createFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (b: Behavior) => {
    setBusy(b.id, true);
    try {
      const res = await fetch(`/api/claudia/behaviors/${b.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activo: !b.activo }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('updateFailed'));
        return;
      }
      setItems((prev) => prev.map((it) => (it.id === b.id ? (data as Behavior) : it)));
    } catch {
      toast.error(t('updateFailed'));
    } finally {
      setBusy(b.id, false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('deleteConfirm'))) return;
    setBusy(id, true);
    try {
      const res = await fetch(`/api/claudia/behaviors/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('deleteFailed'));
        return;
      }
      setItems((prev) => prev.filter((it) => it.id !== id));
      toast.success(t('deleteSuccess'));
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setBusy(id, false);
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const other = items[index + direction];
    const current = items[index];
    if (!other || !current) return;
    setBusy(current.id, true);
    setBusy(other.id, true);
    try {
      const [resA, resB] = await Promise.all([
        fetch(`/api/claudia/behaviors/${current.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orden: other.orden }),
        }),
        fetch(`/api/claudia/behaviors/${other.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orden: current.orden }),
        }),
      ]);
      if (!resA.ok || !resB.ok) {
        const data = await (resA.ok ? resB : resA).json().catch(() => ({}));
        toast.error(data.error ?? t('reorderFailed'));
      }
      // Se recarga SIEMPRE, también cuando falla. El intercambio son dos
      // peticiones independientes: si una pasa y la otra no, la base queda
      // con medio cambio aplicado. Salir sin recargar dejaría la pantalla
      // mostrando el orden viejo mientras el guardado es otro — y el
      // siguiente movimiento se calcularía sobre datos que ya no existen.
      await fetchItems();
    } catch {
      toast.error(t('reorderFailed'));
      await fetchItems();
    } finally {
      setBusy(current.id, false);
      setBusy(other.id, false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <CardDescription>{t('description')}</CardDescription>
        <Button onClick={openCreate} disabled={!canEdit} className="shrink-0">
          <Plus className="mr-1.5 h-4 w-4" />
          {t('add')}
        </Button>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((b, index) => {
              const busy = !!busyIds[b.id];
              return (
                <li
                  key={b.id}
                  className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="flex min-w-0 flex-1 gap-2.5">
                    <span className="mt-0.5 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {b.titulo}
                      </p>
                      <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                        {b.instruccion}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={b.activo}
                        disabled={!canEdit || busy}
                        onCheckedChange={() => handleToggleActive(b)}
                      />
                      <span className="text-xs text-muted-foreground">{t('active')}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canEdit || busy || index === 0}
                        title={t('moveUp')}
                        onClick={() => handleMove(index, -1)}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canEdit || busy || index === items.length - 1}
                        title={t('moveDown')}
                        onClick={() => handleMove(index, 1)}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canEdit || busy}
                        title={t('edit')}
                        onClick={() => openEdit(b)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canEdit || busy}
                        title={t('delete')}
                        onClick={() => handleDelete(b.id)}
                        className="text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {draft?.id ? t('dialogTitleEdit') : t('dialogTitleNew')}
            </DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="claudia-behavior-titulo">{t('titleLabel')}</Label>
                <Input
                  id="claudia-behavior-titulo"
                  value={draft.titulo}
                  onChange={(e) => setDraft({ ...draft, titulo: e.target.value })}
                  placeholder={t('titlePlaceholder')}
                  disabled={saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claudia-behavior-instruccion">{t('instructionLabel')}</Label>
                <Textarea
                  id="claudia-behavior-instruccion"
                  value={draft.instruccion}
                  onChange={(e) => setDraft({ ...draft, instruccion: e.target.value })}
                  placeholder={t('instructionPlaceholder')}
                  rows={5}
                  disabled={saving}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
