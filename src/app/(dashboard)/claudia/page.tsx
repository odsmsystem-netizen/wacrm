'use client';

import { useState } from 'react';
import { BarChart3, ListChecks, Sparkles, Smile } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { ClaudiaKnowledge } from '@/components/claudia/claudia-knowledge';
import { ClaudiaPersonality } from '@/components/claudia/claudia-personality';
import { ClaudiaBehaviors } from '@/components/claudia/claudia-behaviors';
import { ClaudiaUsage } from '@/components/claudia/claudia-usage';

type Tab = 'knowledge' | 'personality' | 'behaviors' | 'usage';

export default function ClaudiaPage() {
  const t = useTranslations('Claudia');
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const canViewUsage = canEdit;
  const [tab, setTab] = useState<Tab>('knowledge');

  return (
    <div>
      <div className="flex items-center gap-2">
        <Sparkles className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('title')}
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>

      {profileLoading ? null : (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="knowledge">
              <Sparkles className="mr-1.5 h-4 w-4" /> {t('tabs.knowledge')}
            </TabsTrigger>
            <TabsTrigger value="personality">
              <Smile className="mr-1.5 h-4 w-4" /> {t('tabs.personality')}
            </TabsTrigger>
            <TabsTrigger value="behaviors">
              <ListChecks className="mr-1.5 h-4 w-4" /> {t('tabs.behaviors')}
            </TabsTrigger>
            {canViewUsage && (
              <TabsTrigger value="usage">
                <BarChart3 className="mr-1.5 h-4 w-4" /> {t('tabs.usage')}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="knowledge" className="mt-4">
            <ClaudiaKnowledge accountId={accountId} canEdit={canEdit} />
          </TabsContent>

          <TabsContent value="personality" className="mt-4">
            <ClaudiaPersonality accountId={accountId} canEdit={canEdit} />
          </TabsContent>

          <TabsContent value="behaviors" className="mt-4">
            <ClaudiaBehaviors accountId={accountId} canEdit={canEdit} />
          </TabsContent>

          {canViewUsage && (
            <TabsContent value="usage" className="mt-4">
              <ClaudiaUsage accountId={accountId} canEdit={canEdit} />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
