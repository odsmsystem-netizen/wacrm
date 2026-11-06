import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------
// Recorre las plantillas de asignación automática de punta a punta contra
// el motor REAL (engine.ts + steps-tree.ts), con una base de datos en
// memoria. No prueba SQL de Postgres: prueba la lógica del motor — qué
// pasos corren, cuáles no, y con qué datos — incluida la espera de 3 min
// y su reanudación.
// ---------------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  sent: [] as { conversationId: string; text: string }[],
}));

vi.mock("@/lib/conversations/assign", () => ({
  // La rotación en sí se prueba aparte; aquí solo importa que asigna.
  resolveAssignee: vi.fn(async () => ({ ok: true, agentId: "agent-ana" })),
}));

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(
    async (a: { conversationId: string; text: string }) => {
      h.sent.push({ conversationId: a.conversationId, text: a.text });
      return { whatsapp_message_id: "wamid-1" };
    },
  ),
  engineSendTemplate: vi.fn(),
  engineSendInteractive: vi.fn(),
}));

vi.mock("./admin-client", () => {
  type Filter = (r: Row) => boolean;

  function builder(table: string) {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let wantsCount = false;
    let head = false;
    let limitN: number | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    const filters: Filter[] = [];

    const rows = () => (h.db[table] ??= []);

    function run(single: boolean) {
      const matched = () => rows().filter((r) => filters.every((f) => f(r)));
      if (op === "insert") {
        const arr = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const created = arr.map((p) => {
          const row = { id: p.id ?? `id-${++h.seq}`, ...p };
          rows().push(row);
          return row;
        });
        return { data: single ? created[0] : created, error: null };
      }
      if (op === "update") {
        const hit = matched();
        hit.forEach((r) => Object.assign(r, payload));
        return { data: single ? (hit[0] ?? null) : hit, error: null };
      }
      let out = matched();
      if (orderBy) {
        const { col, asc } = orderBy;
        out = [...out].sort((a, b) => {
          const x = a[col] as number;
          const y = b[col] as number;
          return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1);
        });
      }
      if (limitN != null) out = out.slice(0, limitN);
      if (wantsCount) {
        return { data: head ? null : out, count: matched().length, error: null };
      }
      if (single) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }

    const b: Record<string, unknown> = {
      select: (_c?: string, o?: { count?: string; head?: boolean }) => {
        if (o?.count) wantsCount = true;
        if (o?.head) head = true;
        return b;
      },
      insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), b),
      update: (p: Row) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
      not: (k: string, _o: string, v: unknown) =>
        (filters.push((r) => (r[k] ?? null) !== v), b),
      gte: (k: string, v: number) => (filters.push((r) => (r[k] as number) >= v), b),
      lte: (k: string, v: string) => (filters.push((r) => (r[k] as string) <= v), b),
      order: (col: string, o?: { ascending?: boolean }) => (
        (orderBy = { col, asc: o?.ascending !== false }), b
      ),
      limit: (n: number) => ((limitN = n), b),
      single: () => Promise.resolve(run(true)),
      maybeSingle: () => Promise.resolve(run(true)),
      then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
        Promise.resolve(run(false)).then(f, r),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

import { runAutomationsForTrigger, resumePendingExecution } from "./engine";
import { insertSteps } from "./steps-tree";
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "./templates";

const ACCOUNT = "acct-1";
const CONTACT = "contact-1";
const CONV = "conv-1";
const HOT_TAG = "tag-caliente";

async function instalar(slug: TemplateSlug, triggerConfig?: Row) {
  const t = AUTOMATION_TEMPLATES[slug];
  const automation = {
    id: `auto-${slug}`,
    account_id: ACCOUNT,
    user_id: "owner-1",
    name: t.name,
    trigger_type: t.trigger_type,
    trigger_config: triggerConfig ?? t.trigger_config,
    is_active: true,
  };
  h.db.automations.push(automation);
  const err = await insertSteps(automation.id, t.steps as never);
  expect(err).toBeNull();
}

function conversacion(over: Row = {}) {
  h.db.conversations = [
    {
      id: CONV,
      account_id: ACCOUNT,
      contact_id: CONTACT,
      assigned_agent_id: null,
      ...over,
    },
  ];
}

function mensajes(...tipos: string[]) {
  h.db.messages = tipos.map((sender_type, i) => ({
    id: `m${i}`,
    conversation_id: CONV,
    sender_type,
  }));
}

/** Corre lo que el cron correría cuando ya pasó la espera. */
async function pasaElTiempo() {
  const due = h.db.automation_pending_executions.filter((p) => p.status === "pending");
  for (const p of due) {
    await resumePendingExecution({
      id: p.id as string,
      automation_id: p.automation_id as string,
      user_id: p.user_id as string,
      account_id: p.account_id as string,
      contact_id: p.contact_id as string | null,
      log_id: p.log_id as string | null,
      parent_step_id: p.parent_step_id as string | null,
      branch: p.branch as "yes" | "no" | null,
      next_step_position: p.next_step_position as number,
      context: (p.context ?? {}) as never,
    });
  }
}

const asignado = () => h.db.conversations[0].assigned_agent_id;
const pendientes = () => h.db.automation_pending_executions.length;

beforeEach(() => {
  h.seq = 0;
  h.sent = [];
  h.db = {
    automations: [],
    automation_steps: [],
    automation_logs: [],
    automation_pending_executions: [],
    contacts: [{ id: CONTACT, account_id: ACCOUNT }],
    conversations: [],
    messages: [],
    profiles: [{ user_id: "agent-ana", account_id: ACCOUNT, full_name: "Ana López" }],
  };
});

const entra = (triggerType: "first_inbound_message" | "new_message_received") =>
  runAutomationsForTrigger({
    accountId: ACCOUNT,
    triggerType,
    contactId: CONTACT,
    context: { conversation_id: CONV, message_text: "hola" },
  });

describe("regla 1 — nadie atiende en 3 min (first_inbound_message)", () => {
  beforeEach(async () => {
    await instalar("auto_assign_unattended");
  });

  it("espera 3 minutos: al entrar no asigna ni escribe nada", async () => {
    conversacion();
    mensajes("customer");
    const antes = Date.now();
    await entra("first_inbound_message");
    expect(asignado()).toBeNull();
    expect(h.sent).toHaveLength(0);
    expect(pendientes()).toBe(1);
    const run = new Date(h.db.automation_pending_executions[0].run_at as string).getTime();
    expect(run - antes).toBeGreaterThanOrEqual(3 * 60_000 - 1000);
    expect(run - antes).toBeLessThanOrEqual(3 * 60_000 + 5000);
  });

  it("si nadie le escribió: asigna y manda bienvenida con el nombre del agente", async () => {
    conversacion();
    mensajes("customer");
    await entra("first_inbound_message");
    await pasaElTiempo();
    expect(asignado()).toBe("agent-ana");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain("Gracias por escribirnos");
    expect(h.sent[0].text).toContain("Ana López");
    expect(h.sent[0].text).not.toContain("{{");
  });

  it("si ya le escribieron desde la bandeja o la API: no asigna ni manda nada", async () => {
    conversacion();
    mensajes("customer", "agent");
    await entra("first_inbound_message");
    await pasaElTiempo();
    expect(asignado()).toBeNull();
    expect(h.sent).toHaveLength(0);
  });

  it("la respuesta de Claudia (sender_type 'bot') NO cuenta como atención: asigna igual", async () => {
    // Claudia envía por la API v1, que guarda sender_type 'bot'.
    conversacion();
    mensajes("customer", "bot");
    await entra("first_inbound_message");
    await pasaElTiempo();
    expect(asignado()).toBe("agent-ana");
    expect(h.sent[0].text).toContain("Ana López");
  });

  it("un mensaje de automatización (bot) NO cuenta como atención", async () => {
    conversacion();
    mensajes("customer", "bot");
    await entra("first_inbound_message");
    await pasaElTiempo();
    expect(asignado()).toBe("agent-ana");
  });

  it("si un administrador asignó durante la espera: no pisa la asignación", async () => {
    conversacion();
    mensajes("customer");
    await entra("first_inbound_message");
    h.db.conversations[0].assigned_agent_id = "agent-beto";
    await pasaElTiempo();
    expect(asignado()).toBe("agent-beto");
    expect(h.sent).toHaveLength(0);
  });
});

describe("regla 2 — ya atendido y sin agente (new_message_received)", () => {
  beforeEach(async () => {
    await instalar("auto_assign_attended_unassigned");
  });

  it("atendido y sin agente: a los 3 min asigna y manda SOLO el aviso (sin saludo)", async () => {
    conversacion();
    mensajes("customer", "agent", "customer");
    await entra("new_message_received");
    expect(pendientes()).toBe(1);
    await pasaElTiempo();
    expect(asignado()).toBe("agent-ana");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain("Ana López");
    expect(h.sent[0].text).not.toMatch(/Hola|Gracias por escribirnos/);
  });

  it("solo Claudia le contestó (bot): no cuenta como atendido, no hace nada", async () => {
    conversacion();
    mensajes("customer", "bot", "customer");
    await entra("new_message_received");
    await pasaElTiempo();
    expect(pendientes()).toBe(0);
    expect(asignado()).toBeNull();
    expect(h.sent).toHaveLength(0);
  });

  it("sin atención previa: no hace nada (lo cubre la regla 1)", async () => {
    conversacion();
    mensajes("customer");
    await entra("new_message_received");
    await pasaElTiempo();
    expect(pendientes()).toBe(0);
    expect(asignado()).toBeNull();
    expect(h.sent).toHaveLength(0);
  });

  it("atendido pero YA asignado: no debe ni siquiera programar una espera", async () => {
    conversacion({ assigned_agent_id: "agent-beto" });
    mensajes("customer", "agent", "customer");
    await entra("new_message_received");
    // Si programa espera, cada mensaje de cada conversación asignada deja
    // una fila pendiente y un log durante 3 minutos sin hacer nada útil.
    expect(pendientes()).toBe(0);
  });

  it("varios mensajes seguidos: asigna una sola vez y avisa una sola vez", async () => {
    conversacion();
    mensajes("customer", "agent");
    await entra("new_message_received");
    await entra("new_message_received");
    await entra("new_message_received");
    await pasaElTiempo();
    expect(asignado()).toBe("agent-ana");
    expect(h.sent).toHaveLength(1);
  });
});

describe("lead caliente — tag_added, sin espera", () => {
  beforeEach(async () => {
    await instalar("auto_assign_hot_lead", { tag_id: HOT_TAG });
  });

  const etiqueta = (tag_id: string) =>
    runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "tag_added",
      contactId: CONTACT,
      context: { tag_id },
    });

  it("etiqueta caliente + sin agente: asigna y avisa al instante", async () => {
    conversacion();
    await etiqueta(HOT_TAG);
    expect(pendientes()).toBe(0);
    expect(asignado()).toBe("agent-ana");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain("Ana López");
  });

  it("otra etiqueta cualquiera no la dispara", async () => {
    conversacion();
    await etiqueta("tag-vip");
    expect(asignado()).toBeNull();
    expect(h.sent).toHaveLength(0);
  });

  it("si ya tiene agente: no reasigna ni manda mensaje", async () => {
    conversacion({ assigned_agent_id: "agent-beto" });
    await etiqueta(HOT_TAG);
    expect(asignado()).toBe("agent-beto");
    expect(h.sent).toHaveLength(0);
  });
});
