'use server';

import { cookies } from 'next/headers';

import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isSupportedLocale,
} from './locales';

/**
 * Persist the user's UI language.
 *
 * Writing the cookie is all this needs to do: Next re-renders the
 * current page whenever a Server Function sets a cookie, and the
 * layout reads the locale through `getLocale()` on every render — so
 * the interface comes back translated with no reload and no
 * revalidatePath call.
 *
 * SECURITY: a Server Action is a POST endpoint reachable by anyone
 * who can reach the app, so the argument is untrusted. An unsupported
 * value is ignored rather than written — the cookie feeds a dynamic
 * import path in request.ts, and that path should only ever hold a
 * locale we ship. No auth check beyond that: the worst a caller can
 * do is change the language of their own browser.
 *
 * httpOnly because nothing client-side reads it; the server resolves
 * the locale and hands the finished messages to the client provider.
 */
export async function setLocale(locale: string): Promise<void> {
  if (!isSupportedLocale(locale)) return;

  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}
