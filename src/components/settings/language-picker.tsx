"use client";

import { useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { LOCALES } from "@/i18n/locales";
import { setLocale } from "@/i18n/set-locale";
import { cn } from "@/lib/utils";

/**
 * UI language picker.
 *
 * Unlike the mode and accent controls next to it — localStorage,
 * applied by a boot script before first paint — the language lives in
 * a cookie the server reads. It has to: the messages are resolved
 * server-side in src/i18n/request.ts, so the choice must be known
 * before the page renders, not after it hydrates.
 *
 * That is also why there is no optimistic state here. Setting a
 * cookie in a Server Function makes Next re-render the current page,
 * so the whole interface comes back translated on its own. Faking the
 * new label locally would only make the pending moment shorter and
 * the failure mode confusing.
 */
export function LanguagePicker() {
  const t = useTranslations("Settings.appearance");
  const active = useLocale();
  const [pending, startTransition] = useTransition();

  return (
    <div
      role="radiogroup"
      aria-label={t("language")}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {LOCALES.map(({ code, label }) => {
        const isActive = code === active;
        return (
          <button
            key={code}
            type="button"
            role="radio"
            aria-checked={isActive}
            // The label is the language's own name, so it is never
            // translated — see the comment in src/i18n/locales.ts.
            aria-label={label}
            disabled={pending || isActive}
            onClick={() => startTransition(() => void setLocale(code))}
            className={cn(
              "flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
              isActive
                ? "border-primary/60 ring-2 ring-primary/40"
                : "border-border hover:bg-muted/40",
              pending && !isActive && "opacity-60",
            )}
          >
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase text-foreground"
            >
              {code}
            </span>
            <span className="flex-1 text-sm font-semibold text-foreground">
              {label}
            </span>
            {isActive && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                <Check className="h-3 w-3" />
                {t("active")}
              </span>
            )}
            {pending && !isActive && (
              <Loader2
                aria-hidden
                className="h-4 w-4 animate-spin text-muted-foreground"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
