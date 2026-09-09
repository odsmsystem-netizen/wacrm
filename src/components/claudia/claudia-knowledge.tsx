'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  Plus,
  RotateCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
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
  DialogDescription,
} from '@/components/ui/dialog';

const MAX_BYTES = 20 * 1024 * 1024;
const FILE_ACCEPT = '.pdf,.docx,.txt,.md,.csv,.json';
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif';

/**
 * Presupuesto blando del bloque de conocimiento, en caracteres.
 *
 * No es un límite que imponga el servidor: es la línea a partir de la
 * cual conviene mirar lo que hay encendido. El texto de TODAS las
 * fuentes activas viaja dentro del prompt de Claudia en cada mensaje de
 * cada conversación, así que este número se paga por conversación, no
 * una vez. 100 000 caracteres son unos 25 000 tokens: holgado para
 * material real, y aún lejos de la ventana del modelo.
 */
const PRESUPUESTO_CARACTERES = 100_000;

/** Aproximación suficiente para un aviso: ~4 caracteres por token. */
const CARACTERES_POR_TOKEN = 4;

/**
 * Cuántos archivos se reintentan como mucho cuando el servidor
 * responde 429. El tope de admin es de 30 acciones por minuto, así que
 * una carga de más de 30 archivos lo toca siempre; sin reintento, todos
 * los restantes se perderían y habría que repetirlos a mano.
 */
const MAX_REINTENTOS_429 = 5;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Tipo = 'documento' | 'imagen' | 'url';
type Estado = 'pendiente' | 'listo' | 'error';

interface KnowledgeDoc {
  id: string;
  tipo: Tipo;
  titulo: string;
  origen: string;
  estado: Estado;
  error: string | null;
  bytes: number;
  /** Largo del texto extraído (columna generada, migración 044). */
  caracteres: number;
  activo: boolean;
  creado: string;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TipoIcon({ tipo }: { tipo: Tipo }) {
  if (tipo === 'imagen') return <ImageIcon className="h-4 w-4 text-muted-foreground" />;
  if (tipo === 'url') return <Link2 className="h-4 w-4 text-muted-foreground" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}

export function ClaudiaKnowledge({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Claudia.knowledge');
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  /** Progreso de una carga en lote. `null` cuando no hay ninguna en curso. */
  const [lote, setLote] = useState<{
    hecho: number;
    total: number;
    nombre: string;
    /** Segundos que falta esperar por el límite de tasa; 0 si no aplica. */
    esperando: number;
  } | null>(null);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const loadedAccountIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [urlTitulo, setUrlTitulo] = useState('');
  const [addingUrl, setAddingUrl] = useState(false);

  const setBusy = (id: string, val: boolean) =>
    setBusyIds((prev) => ({ ...prev, [id]: val }));

  /**
   * Cuánto pesa hoy el bloque de conocimiento dentro del prompt.
   *
   * Solo cuentan las fuentes encendidas Y con texto: una en `error` o
   * apagada no viaja en el prompt, así que sumarla mentiría. Este
   * número se paga en CADA mensaje de CADA conversación, y hasta ahora
   * no había nada en la pantalla que lo insinuara.
   */
  const peso = useMemo(() => {
    const activas = docs.filter((d) => d.activo && d.estado === 'listo');
    const caracteres = activas.reduce((suma, d) => suma + (d.caracteres ?? 0), 0);
    return {
      fuentes: activas.length,
      caracteres,
      tokens: Math.round(caracteres / CARACTERES_POR_TOKEN),
      excedido: caracteres > PRESUPUESTO_CARACTERES,
    };
  }, [docs]);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/claudia/knowledge');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setDocs((data.documents as KnowledgeDoc[]) ?? []);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchDocs();
  }, [accountId, fetchDocs]);

  /**
   * Sube UN archivo. Núcleo compartido por la subida suelta y el lote.
   *
   * Reintenta ante un 429 respetando el `Retry-After` que manda el
   * servidor en vez de adivinar la espera. El tope es de 30 acciones de
   * admin por minuto, así que una carga de más de 30 archivos lo toca
   * siempre; sin esto, todos los restantes se perderían de golpe y
   * habría que repetirlos a mano sin saber cuáles faltaron.
   */
  const subirUno = async (
    file: File,
    apagada: boolean,
  ): Promise<{ doc: KnowledgeDoc } | { error: string }> => {
    for (let intento = 0; intento <= MAX_REINTENTOS_429; intento++) {
      const form = new FormData();
      form.append('file', file);
      // Solo el lote manda el campo. Una subida suelta lo omite y la
      // fuente llega encendida por el DEFAULT de la tabla, exactamente
      // como antes de este cambio.
      if (apagada) form.append('activo', 'false');

      let res: Response;
      try {
        res = await fetch('/api/claudia/knowledge', { method: 'POST', body: form });
      } catch {
        return { error: t('uploadFailed') };
      }

      if (res.status === 429 && intento < MAX_REINTENTOS_429) {
        const espera = Number(res.headers.get('Retry-After')) || 20;
        setLote((prev) => (prev ? { ...prev, esperando: espera } : prev));
        await dormir(espera * 1000);
        setLote((prev) => (prev ? { ...prev, esperando: 0 } : prev));
        continue;
      }

      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { error: (data as { error?: string }).error ?? t('uploadFailed') };
      }
      return { doc: data as KnowledgeDoc };
    }
    return { error: t('uploadFailed') };
  };

  const handleUpload = async (file: File, kind: 'documento' | 'imagen') => {
    if (file.size > MAX_BYTES) {
      toast.error(t('tooLarge'));
      return;
    }
    const setUploading = kind === 'imagen' ? setUploadingImage : setUploadingFile;
    setUploading(true);
    try {
      const r = await subirUno(file, false);
      if ('error' in r) {
        toast.error(r.error);
        return;
      }
      setDocs((prev) => [r.doc, ...prev]);
      if (r.doc.estado === 'error') {
        toast.error(t('uploadPartial', { reason: r.doc.error ?? '' }));
      } else {
        toast.success(t('uploadSuccess'));
      }
    } finally {
      setUploading(false);
    }
  };

  /**
   * Carga en lote: varios documentos en una sola partida.
   *
   * Las fuentes llegan APAGADAS. Todo el texto de las fuentes activas
   * viaja dentro del prompt de Claudia en cada mensaje, así que meter
   * cuarenta documentos de un tirón sin mirarlos es justo lo que la
   * selección múltiple vuelve fácil; apagadas obligan a una decisión.
   */
  const handleUploadLote = async (files: File[]) => {
    const grandes = files.filter((f) => f.size > MAX_BYTES);
    const validos = files.filter((f) => f.size <= MAX_BYTES);
    // Los que no caben se avisan de una vez y no cortan el resto: en un
    // lote de cuarenta, abortar por uno obligaría a repetir todo.
    if (grandes.length > 0) toast.error(t('batchTooLarge', { count: grandes.length }));
    if (validos.length === 0) return;

    setUploadingFile(true);
    const nuevos: KnowledgeDoc[] = [];
    let conError = 0;
    try {
      for (let i = 0; i < validos.length; i++) {
        const file = validos[i];
        setLote({ hecho: i, total: validos.length, nombre: file.name, esperando: 0 });
        // En serie a propósito: el servidor extrae el texto DENTRO del
        // POST, así que lanzar cuarenta peticiones a la vez pondría a
        // competir por CPU y memoria del contenedor a cuarenta parseos
        // de PDF simultáneos.
        const r = await subirUno(file, true);
        if ('error' in r) {
          conError++;
          continue;
        }
        nuevos.push(r.doc);
        // Una fuente guardada pero sin texto (PDF escaneado, por
        // ejemplo) también cuenta como fallo para el resumen: quedó en
        // la lista, pero no le enseñó nada a Claudia.
        if (r.doc.estado === 'error') conError++;
      }
    } finally {
      setLote(null);
      setUploadingFile(false);
    }

    // Una sola escritura al estado en vez de una por archivo: cuarenta
    // renders seguidos de una lista creciente se ven como un parpadeo.
    if (nuevos.length > 0) setDocs((prev) => [...nuevos.reverse(), ...prev]);

    const ok = nuevos.length - nuevos.filter((d) => d.estado === 'error').length;
    if (conError === 0) toast.success(t('batchDone', { ok }));
    else toast.warning(t('batchDoneWithErrors', { ok, error: conError }));
  };

  const handleAddUrl = async () => {
    const url = urlValue.trim();
    if (!url) return;
    setAddingUrl(true);
    try {
      const res = await fetch('/api/claudia/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, titulo: urlTitulo.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('uploadFailed'));
        return;
      }
      setDocs((prev) => [data as KnowledgeDoc, ...prev]);
      if (data.estado === 'error') {
        toast.error(t('uploadPartial', { reason: data.error ?? '' }));
      } else {
        toast.success(t('uploadSuccess'));
      }
      setUrlDialogOpen(false);
      setUrlValue('');
      setUrlTitulo('');
    } catch {
      toast.error(t('uploadFailed'));
    } finally {
      setAddingUrl(false);
    }
  };

  const handleReprocess = async (id: string) => {
    setBusy(id, true);
    try {
      const res = await fetch(`/api/claudia/knowledge/${id}/reprocess`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('reprocessFailed'));
        return;
      }
      const updated = data as KnowledgeDoc;
      setDocs((prev) => prev.map((d) => (d.id === id ? updated : d)));
      if (updated.estado === 'error') {
        toast.error(updated.error ?? t('reprocessFailed'));
      } else {
        toast.success(t('reprocessSuccess'));
      }
    } catch {
      toast.error(t('reprocessFailed'));
    } finally {
      setBusy(id, false);
    }
  };

  const handleToggleActive = async (doc: KnowledgeDoc) => {
    setBusy(doc.id, true);
    try {
      const res = await fetch(`/api/claudia/knowledge/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activo: !doc.activo }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toggleFailed'));
        return;
      }
      setDocs((prev) => prev.map((d) => (d.id === doc.id ? (data as KnowledgeDoc) : d)));
    } catch {
      toast.error(t('toggleFailed'));
    } finally {
      setBusy(doc.id, false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('deleteConfirm'))) return;
    setBusy(id, true);
    try {
      const res = await fetch(`/api/claudia/knowledge/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('deleteFailed'));
        return;
      }
      setDocs((prev) => prev.filter((d) => d.id !== id));
      toast.success(t('deleteSuccess'));
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setBusy(id, false);
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
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!canEdit || uploadingFile}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingFile ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-1.5 h-4 w-4" />
              )}
              {t('uploadFile')}
            </Button>
            <Button
              variant="outline"
              disabled={!canEdit || uploadingImage}
              onClick={() => imageInputRef.current?.click()}
            >
              {uploadingImage ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <ImageIcon className="mr-1.5 h-4 w-4" />
              )}
              {t('uploadImage')}
            </Button>
            <Button
              variant="outline"
              disabled={!canEdit}
              onClick={() => setUrlDialogOpen(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t('addUrl')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('acceptedFiles')}</p>
          <p className="text-xs text-muted-foreground">{t('acceptedImages')}</p>

          {lote && (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {lote.esperando > 0
                ? t('batchWaiting', { seconds: lote.esperando })
                : t('batchProgress', {
                    done: lote.hecho + 1,
                    total: lote.total,
                    name: lote.nombre,
                  })}
            </p>
          )}

          {peso.fuentes > 0 && (
            <p
              className={
                peso.excedido
                  ? 'text-xs font-medium text-amber-600 dark:text-amber-500'
                  : 'text-xs text-muted-foreground'
              }
            >
              {t('promptWeight', {
                sources: peso.fuentes,
                chars: peso.caracteres.toLocaleString(),
                tokens: peso.tokens.toLocaleString(),
              })}
              {peso.excedido ? ` ${t('promptWeightWarning')}` : ''}
            </p>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length === 0) return;
              // Un archivo suelto conserva el camino de siempre y llega
              // encendido; dos o más son un lote y llegan apagados.
              if (files.length === 1) void handleUpload(files[0], 'documento');
              else void handleUploadLote(files);
            }}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleUpload(file, 'imagen');
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {docs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {docs.map((doc) => {
                const busy = !!busyIds[doc.id];
                return (
                  <li
                    key={doc.id}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">
                      <div className="mt-0.5 shrink-0">
                        <TipoIcon tipo={doc.tipo} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">
                            {doc.titulo}
                          </p>
                          <StatusBadge estado={doc.estado} t={t} />
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {doc.origen}
                          {doc.bytes > 0 ? ` · ${formatBytes(doc.bytes)}` : ''}
                        </p>
                        {doc.estado === 'error' && doc.error && (
                          <p className="mt-1 text-xs text-destructive">{doc.error}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={doc.activo}
                          disabled={!canEdit || busy}
                          onCheckedChange={() => handleToggleActive(doc)}
                        />
                        <span className="text-xs text-muted-foreground">
                          {doc.activo ? t('active') : t('inactive')}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {doc.estado === 'error' && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={!canEdit || busy}
                            title={t('reprocess')}
                            onClick={() => handleReprocess(doc.id)}
                          >
                            {busy ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RotateCw className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={!canEdit || busy}
                          onClick={() => handleDelete(doc.id)}
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
      </Card>

      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('urlDialogTitle')}</DialogTitle>
            <DialogDescription>{t('urlDialogDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="claudia-url">{t('urlLabel')}</Label>
              <Input
                id="claudia-url"
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                placeholder={t('urlPlaceholder')}
                disabled={addingUrl}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="claudia-url-titulo">{t('titleLabel')}</Label>
              <Input
                id="claudia-url-titulo"
                value={urlTitulo}
                onChange={(e) => setUrlTitulo(e.target.value)}
                placeholder={t('titlePlaceholder')}
                disabled={addingUrl}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUrlDialogOpen(false)}
              disabled={addingUrl}
            >
              {t('cancel')}
            </Button>
            <Button onClick={handleAddUrl} disabled={addingUrl || !urlValue.trim()}>
              {addingUrl && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t('add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadge({
  estado,
  t,
}: {
  estado: Estado;
  t: ReturnType<typeof useTranslations>;
}) {
  if (estado === 'listo') {
    return (
      <Badge variant="outline" className="border-emerald-500/30 text-emerald-500">
        {t('statusReady')}
      </Badge>
    );
  }
  if (estado === 'error') {
    return <Badge variant="destructive">{t('statusError')}</Badge>;
  }
  return <Badge variant="secondary">{t('statusPending')}</Badge>;
}
