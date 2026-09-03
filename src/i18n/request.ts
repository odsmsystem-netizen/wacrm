import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isSupportedLocale,
} from './locales';

/**
 * Resolve the UI language for this request.
 *
 * Order of precedence:
 *   1. The NEXT_LOCALE cookie — what the user picked in Settings.
 *   2. NEXT_PUBLIC_APP_LOCALE — the deployment's default, for an
 *      install that should open in one language for everyone.
 *   3. English.
 *
 * The cookie has to come first for the picker to mean anything, and
 * the env var has to stay for installs already relying on it: before
 * this, the language was inlined at build time and switching it meant
 * a rebuild (docs/easypanel.md). An install that never sets a cookie
 * behaves exactly as it did.
 *
 * `cookies()` is async in Next 16 — awaiting it is what makes this
 * request-scoped rather than build-time, which is the whole point.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const fromEnv = process.env.NEXT_PUBLIC_APP_LOCALE;

  const locale = isSupportedLocale(fromCookie)
    ? fromCookie
    : isSupportedLocale(fromEnv)
      ? fromEnv
      : DEFAULT_LOCALE;

  // Both candidates are validated against LOCALES above, so this
  // import can only resolve to a dictionary we ship. The catch is for
  // a locale that is listed but whose file has not landed yet.
  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    messages = (await import(`../../messages/en.json`)).default;
  }

  return { locale, messages };
});
