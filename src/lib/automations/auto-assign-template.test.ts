import { describe, it, expect } from 'vitest';
import { AUTOMATION_TEMPLATES } from './templates';
import { validateStepsForActivation } from './validate';
import { seedsToTree } from './steps-tree';

describe('plantilla auto_assign_unattended', () => {
  const t = AUTOMATION_TEMPLATES.auto_assign_unattended;

  it('espera 3 min y revisa que siga sin asignar', () => {
    expect(t.trigger_type).toBe('first_inbound_message');
    expect(t.steps[0]).toMatchObject({
      step_type: 'wait',
      step_config: { amount: 3, unit: 'minutes' },
    });
    expect(t.steps[1].step_config).toMatchObject({ subject: 'conversation_unassigned' });
  });

  it('solo asigna y saluda cuando nadie le ha escrito (rama "no")', () => {
    expect(t.steps[2].step_config).toMatchObject({
      subject: 'conversation_attended',
      operand: 'agent',
    });
    expect(t.steps[2].parent_index).toBe(1);
    for (const i of [3, 4]) {
      expect(t.steps[i].parent_index).toBe(2);
      expect(t.steps[i].branch).toBe('no');
    }
    expect(t.steps[3].step_type).toBe('assign_conversation');
  });

  it('el mensaje trae bienvenida y el nombre del agente', () => {
    const msg = t.steps[4].step_config as { text: string };
    expect(msg.text).toContain('Gracias por escribirnos');
    expect(msg.text).toContain('{{ vars.agent_name }}');
  });
});

describe('plantilla auto_assign_attended_unassigned', () => {
  const t = AUTOMATION_TEMPLATES.auto_assign_attended_unassigned;

  it('revisa "sin asignar" y "atendida" ANTES de esperar, y de nuevo al despertar', () => {
    expect(t.trigger_type).toBe('new_message_received');
    expect(t.steps[0].step_config).toMatchObject({ subject: 'conversation_unassigned' });
    expect(t.steps[1].step_config).toMatchObject({
      subject: 'conversation_attended',
      operand: 'agent',
    });
    expect(t.steps[2]).toMatchObject({
      step_type: 'wait',
      step_config: { amount: 3, unit: 'minutes' },
      parent_index: 1,
      branch: 'yes',
    });
    expect(t.steps[3].step_config).toMatchObject({ subject: 'conversation_unassigned' });
    expect(t.steps[4]).toMatchObject({ step_type: 'assign_conversation', parent_index: 3 });
  });

  it('manda solo el aviso de asignación, sin saludo de bienvenida', () => {
    const msg = t.steps[5].step_config as { text: string };
    expect(msg.text).toContain('{{ vars.agent_name }}');
    expect(msg.text).not.toMatch(/Hola|Gracias por escribirnos/);
  });
});

describe('plantilla auto_assign_hot_lead', () => {
  const t = AUTOMATION_TEMPLATES.auto_assign_hot_lead;

  it('se dispara al agregar una etiqueta, sin espera, y deja elegir la etiqueta', () => {
    expect(t.trigger_type).toBe('tag_added');
    expect(t.trigger_config).toEqual({ tag_id: '' });
    expect(t.steps.some((s) => s.step_type === 'wait')).toBe(false);
  });

  it('solo asigna y avisa si la conversación sigue sin agente', () => {
    expect(t.steps[0].step_config).toMatchObject({ subject: 'conversation_unassigned' });
    expect(t.steps[1]).toMatchObject({ step_type: 'assign_conversation', parent_index: 0, branch: 'yes' });
    const msg = t.steps[2].step_config as { text: string };
    expect(msg.text).toContain('{{ vars.agent_name }}');
  });
});

describe('todas las plantillas pasan la validación de activación', () => {
  // Lo que el CRM exige al guardar una automatización activa. Esta prueba
  // faltaba: el constructor rechazaba las condiciones nuevas por no llevar
  // operando y ninguna otra prueba lo detectó.
  const slugs = [
    'auto_assign_unattended',
    'auto_assign_attended_unassigned',
    'auto_assign_hot_lead',
  ] as const;

  for (const slug of slugs) {
    it(`${slug}: sus pasos son válidos`, () => {
      const tree = seedsToTree(AUTOMATION_TEMPLATES[slug].steps as never);
      expect(validateStepsForActivation(tree as never)).toEqual([]);
    });
  }

  it('una condición sin operando sigue rechazándose cuando sí lo necesita', () => {
    const issues = validateStepsForActivation([
      { step_type: 'condition', step_config: { subject: 'tag_presence' } },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['steps[0].operand']);
  });
});
