"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { ConversationOrigin } from "@/lib/inbox/conversation-origin";

// Colores por origen: Messenger azul, anuncio/publicación ámbar, WhatsApp orgánico verde.
const STYLES: Record<ConversationOrigin, string> = {
  messenger: "bg-blue-500/15 text-blue-400",
  whatsapp_ad: "bg-amber-500/15 text-amber-400",
  whatsapp_post: "bg-amber-500/15 text-amber-400",
  whatsapp_organic: "bg-emerald-500/15 text-emerald-400",
};

/**
 * Insignia del origen de una conversación. `compact` es la de la lista de la bandeja (pequeña, en
 * mayúsculas, junto al nombre); `chip` es la del encabezado de la conversación, que dice el canal
 * completo ("WhatsApp orgánico") porque ahí hay espacio.
 */
export function OriginBadge({
  origin,
  variant = "compact",
}: {
  origin: ConversationOrigin;
  variant?: "compact" | "chip";
}) {
  const t = useTranslations("Inbox.origin");
  const label = t(variant === "chip" ? `${origin}Full` : origin);

  return (
    <span
      className={cn(
        "shrink-0 rounded font-semibold",
        STYLES[origin],
        variant === "compact"
          ? "px-1 text-[9px] uppercase"
          : "px-2 py-0.5 text-[10px]"
      )}
    >
      {label}
    </span>
  );
}
