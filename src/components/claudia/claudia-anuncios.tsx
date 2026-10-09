'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ImagePlus, Loader2, Megaphone, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  estadoPromociones,
  validarHorario,
  valoresPorOmision,
  type PromocionesConfig,
} from '@/lib/claudia/promociones';
import { MAX_BYTES_IMAGEN, MAX_IMAGENES } from '@/lib/claudia/promos-imagenes';

const MAX_TEXTO = 5_000;
const DIAS = [1, 2, 3, 4, 5, 6, 7] as const;
const TIPOS_ADMITIDOS = ['image/jpeg', 'image/png'];

/** Mismo criterio que la base de conocimiento: reintentos ante un 429. */
const MAX_REINTENTOS_429 = 5;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Imagen {
  id: string;
  nombre: string;
  tamano: number;
  orden: number;
  url: string;
}

type DatosConfig = {
  promociones_activas?: boolean;
  promociones_siempre?: boolean;
  promociones_texto?: string;
  promociones_dias?: number[];
  promociones_inicio?: string;
  promociones_fin?: string;
};

function aConfig(d: DatosConfig): PromocionesConfig {
  return {
    activas: d.promociones_activas === true,
    siempre: d.promociones_siempre === true,
    texto: d.promociones_texto ?? '',
    dias: Array.isArray(d.promociones_dias) ? d.promociones_dias : valoresPorOmision.dias,
    inicio: d.promociones_inicio ?? valoresPorOmision.inicio,
    fin: d.promociones_fin ?? valoresPorOmision.fin,
  };
}

export function ClaudiaAnuncios({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Claudia.anuncios');
  const [loading, setLoading] = useState(true);
  /** Lo último que confirmó el servidor. */
  const [cfg, setCfg] = useState<PromocionesConfig>(valoresPorOmision);
  /** Borradores que el usuario edita antes de pulsar Guardar. */
  const [texto, setTexto] = useState('');
  const [dias, setDias] = useState<number[]>(valoresPorOmision.dias);
  const [inicio, setInicio] = useState(valoresPorOmision.inicio);
  const [fin, setFin] = useState(valoresPorOmision.fin);
  const [guardandoTexto, setGuardandoTexto] = useState(false);
  const [guardandoHorario, setGuardandoHorario] = useState(false);
  const [guardandoSwitch, setGuardandoSwitch] = useState(false);

  const [imagenes, setImagenes] = useState<Imagen[]>([]);
  const [subiendo, setSubiendo] = useState<{
    hecho: number;
    total: number;
    nombre: string;
    esperando: number;
  } | null>(null);
  const [aBorrar, setABorrar] = useState<Imagen | null>(null);
  const [borrando, setBorrando] = useState(false);

  /** «Ahora» para el estado en vivo; se recalcula cada 30 s. */
  const [ahora, setAhora] = useState(() => new Date());
  const loadedAccountIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setInterval(() => setAhora(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Si la carga falla NO se muestra el formulario: tendría los valores por omisión y un clic en
  // Guardar los escribiría encima del horario y del texto reales.
  const [cargaFallida, setCargaFallida] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    setCargaFallida(false);
    try {
      const [rc, ri] = await Promise.all([
        fetch('/api/claudia/config'),
        fetch('/api/claudia/promociones/imagenes'),
      ]);
      const dc = await rc.json().catch(() => ({}));
      const di = await ri.json().catch(() => ({}));
      if (!rc.ok || !ri.ok) {
        toast.error(dc.error ?? di.error ?? t('loadFailed'));
        setCargaFallida(true);
        return;
      }
      const c = aConfig(dc);
      setCfg(c);
      setTexto(c.texto);
      setDias(c.dias);
      setInicio(c.inicio);
      setFin(c.fin);
      setImagenes((di.imagenes as Imagen[]) ?? []);
    } catch {
      toast.error(t('loadFailed'));
      setCargaFallida(true);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void cargar();
  }, [accountId, cargar]);

  /** PATCH con los campos dados; devuelve la config confirmada o null si falló. */
  const guardar = async (cambios: Record<string, unknown>): Promise<PromocionesConfig | null> => {
    try {
      const res = await fetch('/api/claudia/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return null;
      }
      return aConfig(data);
    } catch {
      toast.error(t('saveFailed'));
      return null;
    }
  };

  /**
   * Interruptores (promociones y «Siempre activa»): PATCH optimista con
   * reversa si falla. Solo se tocan esos dos campos de `cfg`, para no
   * pisar los borradores de texto y horario que el usuario esté editando.
   */
  const alternar = async (campo: 'activas' | 'siempre', valor: boolean) => {
    const anterior = cfg[campo];
    setCfg((c) => ({ ...c, [campo]: valor }));
    setGuardandoSwitch(true);
    const clave = campo === 'activas' ? 'promociones_activas' : 'promociones_siempre';
    const r = await guardar({ [clave]: valor });
    setGuardandoSwitch(false);
    if (!r) {
      setCfg((c) => ({ ...c, [campo]: anterior }));
      return;
    }
    setCfg((c) => ({ ...c, [campo]: r[campo] }));
  };

  const guardarTexto = async () => {
    setGuardandoTexto(true);
    const r = await guardar({ promociones_texto: texto });
    setGuardandoTexto(false);
    if (!r) return;
    setCfg((c) => ({ ...c, texto: r.texto }));
    setTexto(r.texto);
    toast.success(t('saveSuccess'));
  };

  const validacion = validarHorario({ dias, inicio, fin });
  const errorHorario = validacion.ok
    ? null
    : validacion.error === 'dias'
      ? t('errDays')
      : t('errOrder');
  const horarioSinGuardar =
    inicio !== cfg.inicio ||
    fin !== cfg.fin ||
    [...dias].sort().join() !== [...cfg.dias].sort().join();

  const guardarHorario = async () => {
    if (!validacion.ok) return;
    setGuardandoHorario(true);
    const r = await guardar({
      promociones_dias: [...dias].sort((a, b) => a - b),
      promociones_inicio: inicio,
      promociones_fin: fin,
    });
    setGuardandoHorario(false);
    if (!r) return;
    setCfg((c) => ({ ...c, dias: r.dias, inicio: r.inicio, fin: r.fin }));
    setDias(r.dias);
    setInicio(r.inicio);
    setFin(r.fin);
    toast.success(t('saveSuccess'));
  };

  const alternarDia = (dia: number) =>
    setDias((prev) => (prev.includes(dia) ? prev.filter((d) => d !== dia) : [...prev, dia]));

  /** Sube UNA imagen; reintenta ante 429 respetando `Retry-After`. */
  const subirUna = async (file: File): Promise<Imagen | { error: string }> => {
    for (let intento = 0; intento <= MAX_REINTENTOS_429; intento++) {
      const form = new FormData();
      form.append('archivo', file);
      let res: Response;
      try {
        res = await fetch('/api/claudia/promociones/imagenes', { method: 'POST', body: form });
      } catch {
        return { error: t('uploadFailed', { name: file.name }) };
      }
      if (res.status === 429 && intento < MAX_REINTENTOS_429) {
        const espera = Number(res.headers.get('Retry-After')) || 20;
        setSubiendo((prev) => (prev ? { ...prev, esperando: espera } : prev));
        await dormir(espera * 1000);
        setSubiendo((prev) => (prev ? { ...prev, esperando: 0 } : prev));
        continue;
      }
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { error: `${file.name}: ${(data as { error?: string }).error ?? t('saveFailed')}` };
      }
      return data as Imagen;
    }
    return { error: t('uploadFailed', { name: file.name }) };
  };

  const subirVarias = async (files: File[]) => {
    // Validación previa en el navegador: ahorra viajes, pero la que
    // manda es la del servidor (que mira los primeros bytes).
    const validos: File[] = [];
    for (const f of files) {
      if (!TIPOS_ADMITIDOS.includes(f.type)) {
        toast.error(t('errType', { name: f.name }));
      } else if (f.size > MAX_BYTES_IMAGEN) {
        toast.error(t('errSize', { name: f.name }));
      } else {
        validos.push(f);
      }
    }
    const cupo = Math.max(0, MAX_IMAGENES - imagenes.length);
    if (validos.length > cupo) {
      toast.error(t('errLimit', { max: MAX_IMAGENES, skipped: validos.length - cupo }));
    }
    const aSubir = validos.slice(0, cupo);
    if (aSubir.length === 0) return;

    const nuevas: Imagen[] = [];
    try {
      // En serie a propósito: una por petición, para saber cuál falló y
      // no saturar el límite de tasa del servidor.
      for (let i = 0; i < aSubir.length; i++) {
        setSubiendo({ hecho: i, total: aSubir.length, nombre: aSubir[i].name, esperando: 0 });
        const r = await subirUna(aSubir[i]);
        if ('error' in r) toast.error(r.error);
        else nuevas.push(r);
      }
    } finally {
      setSubiendo(null);
    }
    if (nuevas.length > 0) {
      setImagenes((prev) => [...prev, ...nuevas]);
      toast.success(t('uploadDone', { ok: nuevas.length }));
    }
  };

  const confirmarBorrado = async () => {
    if (!aBorrar) return;
    setBorrando(true);
    try {
      const res = await fetch(`/api/claudia/promociones/imagenes/${aBorrar.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('deleteFailed'));
        return;
      }
      setImagenes((prev) => prev.filter((i) => i.id !== aBorrar.id));
      toast.success(t('deleteSuccess'));
      setABorrar(null);
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setBorrando(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (cargaFallida) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
          <Button variant="outline" onClick={() => void cargar()}>
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const estado = estadoPromociones(cfg, ahora);
  const puede = estado === 'siempre' || estado === 'dentro';
  const razon = {
    apagadas: t('reasonOff'),
    siempre: t('reasonAlways'),
    dentro: t('reasonInside'),
    fuera: t('reasonOutside'),
  }[estado];
  const bloqueado = !canEdit;
  const lleno = imagenes.length >= MAX_IMAGENES;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="h-4 w-4 text-primary" /> {t('switchLabel')}
          </CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              checked={cfg.activas}
              disabled={bloqueado || guardandoSwitch}
              onCheckedChange={(v) => void alternar('activas', v)}
              aria-label={t('switchLabel')}
            />
            <p className="text-xs text-muted-foreground">{t('switchHint')}</p>
          </div>

          <p
            aria-live="polite"
            className={cn(
              'rounded-md border p-3 text-sm',
              puede
                ? 'border-emerald-500/40 bg-emerald-500/10 text-foreground'
                : 'border-border bg-muted/40 text-foreground',
            )}
          >
            <span className="font-medium">{puede ? t('statusYes') : t('statusNo')}</span>{' '}
            <span className="text-muted-foreground">{razon}</span>
          </p>

          {!cfg.activas && (
            <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
              {t('offNotice')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('textTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value.slice(0, MAX_TEXTO))}
            placeholder={t('textPlaceholder')}
            rows={6}
            maxLength={MAX_TEXTO}
            disabled={bloqueado || guardandoTexto}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('chars', { count: texto.length.toLocaleString(), max: MAX_TEXTO.toLocaleString() })}</span>
            <Button
              size="sm"
              disabled={bloqueado || guardandoTexto || texto === cfg.texto}
              onClick={() => void guardarTexto()}
            >
              {guardandoTexto && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('scheduleTitle')}</CardTitle>
          <CardDescription>{t('timezoneNote')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <Switch
              checked={cfg.siempre}
              disabled={bloqueado || guardandoSwitch}
              onCheckedChange={(v) => void alternar('siempre', v)}
              aria-label={t('alwaysLabel')}
            />
            <div>
              <p className="text-sm font-medium text-foreground">{t('alwaysLabel')}</p>
              <p className="text-xs text-muted-foreground">{t('alwaysHint')}</p>
            </div>
          </div>

          {/* Con «Siempre activa» el horario no cuenta: se ve atenuado y
              deshabilitado, pero los valores NO se borran. */}
          <div
            className={cn('space-y-4', cfg.siempre && 'pointer-events-none opacity-50')}
            aria-disabled={cfg.siempre}
          >
            <div className="flex flex-wrap gap-2">
              {DIAS.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={dias.includes(d)}
                  disabled={bloqueado || cfg.siempre}
                  onClick={() => alternarDia(d)}
                  className={cn(
                    'min-w-12 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed',
                    dias.includes(d)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {t(`day${d}`)}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label htmlFor="promo-inicio">{t('timeStart')}</Label>
                <input
                  id="promo-inicio"
                  type="time"
                  value={inicio}
                  disabled={bloqueado || cfg.siempre}
                  onChange={(e) => setInicio(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="promo-fin">{t('timeEnd')}</Label>
                <input
                  id="promo-fin"
                  type="time"
                  value={fin}
                  disabled={bloqueado || cfg.siempre}
                  onChange={(e) => setFin(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed"
                />
              </div>
              <Button
                size="sm"
                disabled={bloqueado || cfg.siempre || guardandoHorario || !validacion.ok || !horarioSinGuardar}
                onClick={() => void guardarHorario()}
              >
                {guardandoHorario && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {t('saveSchedule')}
              </Button>
            </div>

            {errorHorario && (
              <p className="text-xs font-medium text-destructive" role="alert">
                {errorHorario}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>{t('imagesTitle')}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {t('imagesCount', { count: imagenes.length, max: MAX_IMAGENES })}
            </span>
          </CardTitle>
          <CardDescription>{t('imagesHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Button
              variant="outline"
              disabled={bloqueado || subiendo !== null || lleno}
              onClick={() => inputRef.current?.click()}
            >
              {subiendo ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus className="mr-1.5 h-4 w-4" />
              )}
              {t('upload')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length > 0) void subirVarias(files);
              }}
            />
          </div>

          {subiendo && (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {subiendo.esperando > 0
                ? t('batchWaiting', { seconds: subiendo.esperando })
                : t('uploadProgress', {
                    done: subiendo.hecho + 1,
                    total: subiendo.total,
                    name: subiendo.nombre,
                  })}
            </p>
          )}

          {imagenes.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {imagenes.map((img) => (
                <li
                  key={img.id}
                  className="group relative overflow-hidden rounded-lg border border-border bg-card"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- miniatura de un bucket público; next/image exigiría configurar el dominio */}
                  <img
                    src={img.url}
                    alt={img.nombre}
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                  <div className="flex items-center justify-between gap-1 p-2">
                    <p className="truncate text-xs text-foreground" title={img.nombre}>
                      {img.nombre}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={bloqueado}
                      title={t('delete')}
                      aria-label={t('delete')}
                      onClick={() => setABorrar(img)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={aBorrar !== null} onOpenChange={(o) => !o && !borrando && setABorrar(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteConfirm', { name: aBorrar?.nombre ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={borrando} onClick={() => setABorrar(null)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" disabled={borrando} onClick={() => void confirmarBorrado()}>
              {borrando && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
