'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface MessengerStatus {
  connected: boolean;
  page_id?: string;
  page_name?: string;
  verify_token?: string;
  webhook_url: string;
}

export function MessengerConfig() {
  const t = useTranslations('Settings.messenger');
  const [status, setStatus] = useState<MessengerStatus | null>(null);
  const [pageId, setPageId] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/messenger/config');
      if (!res.ok) {
        setError(t('errorGeneric'));
        return;
      }
      const data: MessengerStatus = await res.json();
      setStatus(data);
      // Desconectada (hay fila pero el token dejó de servir): se precarga el ID
      // de la página, sin pisar lo que el usuario ya haya escrito.
      if (!data.connected && data.page_id) {
        setPageId((current) => current || data.page_id!);
      }
    } catch {
      setError(t('errorGeneric'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/messenger/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: pageId, page_access_token: token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? t('errorGeneric'));
        return;
      }
      setStatus(body);
      setToken('');
    } catch {
      setError(t('errorGeneric'));
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    setError(null);
    try {
      const res = await fetch('/api/messenger/config', { method: 'DELETE' });
      if (!res.ok) {
        setError(t('errorGeneric'));
        return;
      }
      setPageId('');
      await load();
    } catch {
      setError(t('errorGeneric'));
    }
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription className="text-muted-foreground">
          {status?.connected
            ? t('connectedTo', { name: status.page_name ?? status.page_id ?? '' })
            : t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {!status?.connected && status?.page_id && (
          <div
            role="alert"
            className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
          >
            {t('disconnectedNotice')}
          </div>
        )}

        {!status?.connected && (
          <form onSubmit={connect} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="messenger-page-id" className="text-muted-foreground">
                {t('pageId')}
              </Label>
              <Input
                id="messenger-page-id"
                value={pageId}
                onChange={(e) => setPageId(e.target.value)}
                required
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="messenger-token" className="text-muted-foreground">
                {t('pageToken')}
              </Label>
              <Input
                id="messenger-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                className="border-border bg-muted text-foreground"
              />
              <p className="text-xs text-muted-foreground">{t('tokenHidden')}</p>
            </div>
            <Button type="submit" disabled={saving} className="w-fit">
              {saving ? t('saving') : t('connect')}
            </Button>
          </form>
        )}

        {status?.connected && (
          <>
            <div className="flex flex-col gap-1">
              <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
              <code className="rounded bg-muted px-3 py-2 text-xs text-foreground">
                {status.webhook_url}
              </code>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-muted-foreground">{t('verifyToken')}</Label>
              <code className="rounded bg-muted px-3 py-2 text-xs text-foreground">
                {status.verify_token}
              </code>
            </div>
            <p className="text-xs text-muted-foreground">{t('setupHint')}</p>
            <Button variant="outline" onClick={disconnect} className="w-fit">
              {t('disconnect')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
