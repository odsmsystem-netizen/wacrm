import { beforeEach, describe, expect, it, vi } from 'vitest';

// La API pública es el camino por el que Claudia manda sus mensajes. Deben
// quedar como 'bot': si quedaran como 'agent' contarían como "una persona ya
// atendió", y las reglas de asignación automática no se dispararían.

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  resolveConversationByPhone: vi.fn(),
  sendMessageToConversation: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: mocks.requireApiKey }));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: mocks.resolveConversationByPhone,
}));
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessageToConversation: mocks.sendMessageToConversation,
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiKey.mockResolvedValue({ supabase: {}, accountId: 'acct-1' });
  mocks.resolveConversationByPhone.mockResolvedValue({
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactCreated: false,
  });
  mocks.sendMessageToConversation.mockResolvedValue({
    messageId: 'm-1',
    whatsappMessageId: 'wamid-1',
  });
});

describe('POST /api/v1/messages', () => {
  it("envía el mensaje marcado como 'bot'", async () => {
    const res = await POST(
      new Request('http://x.test/api/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ to: '+5213330000000', type: 'text', text: 'hola' }),
      })
    );
    expect(res.status).toBe(201);
    expect(mocks.sendMessageToConversation).toHaveBeenCalledTimes(1);
    const params = mocks.sendMessageToConversation.mock.calls[0][2];
    expect(params.senderType).toBe('bot');
    expect(params.conversationId).toBe('conv-1');
  });
});
