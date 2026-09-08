// ============================================================
// De la configuración al texto que Claudia pega en su cerebro.
//
// El bloque se arma aquí, en el CRM, y no en el agente de Python. Así
// cambiar cómo suena "más seria" o "más amigable" es editar este
// archivo, no reconstruir la imagen del agente.
//
// REGLA QUE NO SE PUEDE ROMPER: para la misma configuración, esta
// función debe devolver el MISMO texto, byte por byte. Claudia mete
// este bloque dentro de la parte cacheada de su prompt, y el caché de
// Anthropic casa por texto exacto. Una fecha, un "generado a las
// 14:03" o un orden que dependa de cómo vinieron las filas de la base
// invalidaría el caché en cada turno y multiplicaría el costo de cada
// conversación. Por eso todo lo que entra aquí se ordena de forma
// explícita y no se estampa nada del momento actual.
// ============================================================

export interface FuenteConocimiento {
  id: string;
  titulo: string;
  tipo: 'documento' | 'imagen' | 'url';
  origen: string;
  texto: string;
}

export interface Comportamiento {
  id: string;
  titulo: string;
  instruccion: string;
  orden: number;
}

export interface ConfiguracionClaudia {
  personalidad: number;
  instruccionesExtra: string;
  conocimiento: FuenteConocimiento[];
  comportamientos: Comportamiento[];
}

/**
 * Cómo suena cada nivel. Se describe el COMPORTAMIENTO y no el
 * adjetivo: "usa emojis con moderación" le dice algo accionable al
 * modelo; "sé amigable" no.
 */
const PERSONALIDADES: Record<number, string> = {
  1: 'Formal y directa. Trata de usted. Nada de emojis ni expresiones coloquiales. Frases cortas, centradas en el dato que el cliente pidió. No hagas conversación de cortesía más allá del saludo.',
  2: 'Profesional y sobria. Trata de usted. Emojis solo si el cliente los usa primero. Cordial, pero sin florituras.',
  3: 'Cercana y profesional, el equilibrio por omisión. Tuteas con naturalidad, algún emoji ocasional, y mantienes el foco en resolver.',
  4: 'Cálida y conversacional. Tuteas, usas emojis con soltura, celebras los avances del cliente y te interesas por lo que necesita antes de ir al grano.',
  5: 'Muy cercana y expresiva. Hablas como una compañera de trabajo de confianza: tuteo, emojis, expresiones mexicanas naturales, y un tono que invita a seguir la conversación. Sin perder nunca la precisión de los datos.',
};

/** Nombre corto de cada nivel, para la interfaz. */
export const ETIQUETAS_PERSONALIDAD: Record<number, string> = {
  1: 'Muy formal',
  2: 'Formal',
  3: 'Equilibrada',
  4: 'Amigable',
  5: 'Muy cercana',
};

export function textoPersonalidad(nivel: number): string {
  return PERSONALIDADES[nivel] ?? PERSONALIDADES[3];
}

/**
 * El bloque completo que Claudia anexa a su prompt base. Cadena vacía
 * cuando no hay nada configurado — así el agente sin configurar se
 * comporta EXACTAMENTE como antes de que existiera este módulo, sin un
 * encabezado huérfano colgando del prompt.
 */
export function construirBloquePrompt(cfg: ConfiguracionClaudia): string {
  const partes: string[] = [];

  // La personalidad solo se anexa si NO es la de por omisión: el prompt
  // base ya define un tono, y repetirlo en el nivel 3 solo gastaría
  // tokens diciendo lo mismo dos veces.
  if (cfg.personalidad !== 3) {
    partes.push(`## Tono de tus respuestas\n${textoPersonalidad(cfg.personalidad)}`);
  }

  const comportamientos = [...cfg.comportamientos].sort(
    // Desempate por id para que dos comportamientos con el mismo orden
    // no bailen entre consultas. Sin esto el texto cambiaría solo y el
    // caché se caería sin motivo.
    (a, b) => a.orden - b.orden || a.id.localeCompare(b.id),
  );
  if (comportamientos.length > 0) {
    const lineas = comportamientos
      .map((c) => `### ${c.titulo.trim()}\n${c.instruccion.trim()}`)
      .join('\n\n');
    partes.push(
      '## Objetivos y comportamientos adicionales\n' +
        'Estas indicaciones las configuró la empresa y mandan sobre tus ' +
        'hábitos generales, pero NUNCA sobre las reglas de seguridad ni ' +
        'sobre la obligación de no inventar datos.\n\n' +
        lineas,
    );
  }

  const fuentes = [...cfg.conocimiento]
    .filter((f) => f.texto.trim().length > 0)
    .sort((a, b) => a.titulo.localeCompare(b.titulo) || a.id.localeCompare(b.id));
  if (fuentes.length > 0) {
    const bloques = fuentes
      .map((f) => {
        const procedencia = f.origen.trim() ? ` — ${f.origen.trim()}` : '';
        return `### ${f.titulo.trim()}${procedencia}\n${f.texto.trim()}`;
      })
      .join('\n\n');
    partes.push(
      '## Base de conocimiento de la empresa\n' +
        'Material que subió la empresa para que puedas responder dudas ' +
        'específicas. Úsalo como fuente de verdad. Si el cliente pregunta ' +
        'algo que NO está aquí ni en el resto de tu información, dilo en ' +
        'vez de deducirlo.\n\n' +
        bloques,
    );
  }

  const extra = cfg.instruccionesExtra.trim();
  if (extra) {
    partes.push(`## Indicaciones adicionales\n${extra}`);
  }

  return partes.join('\n\n');
}
