'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

  const handleUpload = async (file: File, kind: 'documento' | 'imagen') => {
    if (file.size > MAX_BYTES) {
      toast.error(t('tooLarge'));
      return;
    }
    const setUploading = kind === 'imagen' ? setUploadingImage : setUploadingFile;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/claudia/knowledge', { method: 'POST', body: form });
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
    } catch {
      toast.error(t('uploadFailed'));
    } finally {
      setUploading(false);
    }
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
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleUpload(file, 'documento');
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
