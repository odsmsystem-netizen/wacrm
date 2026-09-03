// ============================================================
// Supported UI languages.
//
// Adding one is three steps: drop `messages/<code>.json` next to the
// others, add the code here, and add it to TRANSLATED_LOCALES in
// src/i18n/messages.test.ts so the parity test guards it. The picker
// in Settings builds itself from this list.
//
// `label` is deliberately written in the language it names — someone
// looking for Spanish scans for "Español", not for "Spanish". That is
// also why it is not a translated string: a language picker that
// renames its own options when you switch locale is unusable for
// anyone who picked the wrong one by mistake.
// ============================================================

export const LOCALE_COOKIE = 'NEXT_LOCALE';

/** One year. The choice is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'ko', label: '한국어' },
] as const;

export type Locale = (typeof LOCALES)[number]['code'];

export const LOCALE_CODES = LOCALES.map((l) => l.code) as readonly string[];

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Narrow an untrusted string to a supported locale.
 *
 * The cookie is client-controlled: anyone can set NEXT_LOCALE to
 * anything, and the value ends up in a dynamic `import()` path in
 * request.ts. Validating here — rather than trusting the cookie and
 * letting the import fail — keeps a crafted value from reaching the
 * module resolver at all.
 */
export function isSupportedLocale(value: string | undefined): value is Locale {
  return value !== undefined && LOCALE_CODES.includes(value);
}
