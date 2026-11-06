import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/types'

export type TemplateSlug =
  | 'welcome_message'
  | 'out_of_office'
  | 'lead_qualifier'
  | 'follow_up_reminder'
  | 'auto_assign_unattended'
  | 'auto_assign_attended_unassigned'
  | 'auto_assign_hot_lead'

export interface TemplateStepSeed {
  step_type: AutomationStepType
  step_config: AutomationStepConfig
  branch?: 'yes' | 'no' | null
  /** Index (within this seed list) of the Condition parent, if nested. */
  parent_index?: number | null
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: AutomationTriggerConfig
  steps: TemplateStepSeed[]
}

/**
 * Fecha desde la cual `sender_type = 'agent'` significa "una persona".
 * Antes, los envíos por la API v1 (Claudia) también se guardaban como
 * 'agent'; el cambio que los pasa a 'bot' quedó en producción el
 * 2026-11-06 a las 18:29 UTC. Un margen después se fija el corte.
 */
export const HUMAN_MESSAGES_SINCE = '2026-11-06T18:30:00.000Z'

export const AUTOMATION_TEMPLATES: Record<TemplateSlug, AutomationTemplateDefinition> = {
  welcome_message: {
    slug: 'welcome_message',
    name: 'Welcome Message',
    description: 'Auto-reply to first-time contacts with a greeting.',
    // first_inbound_message (added in PR #33) catches both brand-new
    // contacts AND manually-added/imported contacts on their first-ever
    // reply, which is what a user setting up a "welcome" automation
    // almost always wants. new_contact_created would miss the
    // manually-imported case.
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
        },
      },
      {
        step_type: 'add_tag',
        step_config: { tag_id: '' },
      },
    ],
  },
  out_of_office: {
    slug: 'out_of_office',
    name: 'Out of Office',
    description: 'Auto-reply during off-hours so nobody is left waiting.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '18:00-09:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.",
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  lead_qualifier: {
    slug: 'lead_qualifier',
    name: 'Lead Qualifier',
    description: 'Ask qualification questions to filter inbound leads.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['pricing', 'quote', 'buy'],
      match_type: 'contains',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?",
        },
      },
      {
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  auto_assign_unattended: {
    slug: 'auto_assign_unattended',
    name: 'Asignar si nadie atiende en 3 min',
    description:
      'Si a los 3 minutos ninguna persona del equipo le ha escrito al contacto y su conversación sigue sin agente, la asigna por turnos y le envía la bienvenida con el nombre del agente. Los mensajes de Claudia no cuentan como atención. Si una persona ya le escribió, no hace nada.',
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 3, unit: 'minutes' },
      },
      {
        step_type: 'condition',
        step_config: { subject: 'conversation_unassigned' },
      },
      {
        step_type: 'condition',
        step_config: { subject: 'conversation_attended', operand: 'agent' },
        parent_index: 1,
        branch: 'yes',
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
        parent_index: 2,
        branch: 'no',
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            '¡Hola! Gracias por escribirnos. Un agente se pondrá en contacto con usted: {{ vars.agent_name }}.',
        },
        parent_index: 2,
        branch: 'no',
      },
    ],
  },
  auto_assign_attended_unassigned: {
    slug: 'auto_assign_attended_unassigned',
    name: 'Asignar contacto ya atendido sin agente (3 min)',
    description:
      'Si una persona del equipo ya le escribió al contacto pero su conversación sigue sin agente, a los 3 minutos la asigna por turnos y solo le avisa el nombre del agente. Los mensajes de Claudia no cuentan como atención.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      // Primero lo barato: si ya tiene agente (lo normal en casi todos los
      // mensajes), no se programa ninguna espera.
      {
        step_type: 'condition',
        step_config: { subject: 'conversation_unassigned' },
      },
      {
        step_type: 'condition',
        step_config: {
          subject: 'conversation_attended',
          operand: 'agent',
          value: HUMAN_MESSAGES_SINCE,
        },
        parent_index: 0,
        branch: 'yes',
      },
      {
        step_type: 'wait',
        step_config: { amount: 3, unit: 'minutes' },
        parent_index: 1,
        branch: 'yes',
      },
      // Se vuelve a revisar al despertar: en 3 minutos alguien pudo asignarla.
      {
        step_type: 'condition',
        step_config: { subject: 'conversation_unassigned' },
        parent_index: 1,
        branch: 'yes',
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
        parent_index: 3,
        branch: 'yes',
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            'Le hemos asignado a un agente: {{ vars.agent_name }}. Se pondrá en contacto con usted.',
        },
        parent_index: 3,
        branch: 'yes',
      },
    ],
  },
  auto_assign_hot_lead: {
    slug: 'auto_assign_hot_lead',
    name: 'Asignar lead caliente de inmediato',
    description:
      'Cuando un contacto recibe la etiqueta de lead caliente (elige cuál) y su conversación no tiene agente, la asigna por turnos al instante y le avisa el nombre del agente.',
    trigger_type: 'tag_added',
    // El tag_id se elige al activarla: el id de la etiqueta es de cada cuenta.
    trigger_config: { tag_id: '' },
    steps: [
      {
        step_type: 'condition',
        step_config: { subject: 'conversation_unassigned' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
        parent_index: 0,
        branch: 'yes',
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            'Gracias por la información. Le atenderá personalmente un agente: {{ vars.agent_name }}.',
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: 'Follow-up Reminder',
    description: 'Send a nudge if a contact has not replied within 24 hours.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Just circling back — did you have any other questions for us? Happy to help!",
        },
      },
    ],
  },
}

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null
}
