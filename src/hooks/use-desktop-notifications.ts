"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Message } from "@/types";

type Permission = NotificationPermission | "unsupported";

const CONTENT_LABELS: Record<string, string> = {
  image: "📷 Imagen",
  video: "🎥 Video",
  audio: "🎤 Audio",
  document: "📄 Documento",
  sticker: "Sticker",
  location: "📍 Ubicación",
};

/**
 * Avisos del sistema operativo cuando llega un mensaje de WhatsApp o
 * Messenger y la app está minimizada o sin foco. Escucha los INSERT de
 * `messages` por Realtime (RLS ya limita a la cuenta del usuario), así
 * que funciona mientras la ventana siga abierta, aunque esté minimizada.
 *
 * El permiso del navegador solo se puede pedir desde un clic, por eso
 * `enable()` se enlaza a un botón y no se pide al cargar.
 */
export function useDesktopNotifications() {
  const [permission, setPermission] = useState<Permission>("unsupported");

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    // Leer el permiso solo es posible en el cliente; inicializarlo en el
    // useState rompería la hidratación del SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPermission(Notification.permission);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  const enable = useCallback(async () => {
    if (!("Notification" in window)) return;
    setPermission(await Notification.requestPermission());
  }, []);

  useEffect(() => {
    if (permission !== "granted") return;
    const supabase = createClient();

    const channel = supabase
      .channel("desktop-notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        async (payload) => {
          const msg = payload.new as Message;
          if (msg.sender_type !== "customer") return;
          // Con la app a la vista y enfocada, el badge del menú basta.
          if (!document.hidden && document.hasFocus()) return;

          const { data } = await supabase
            .from("conversations")
            .select("id, channel, contact:contacts(name, phone)")
            .eq("id", msg.conversation_id)
            .maybeSingle();
          const contact = Array.isArray(data?.contact)
            ? data?.contact[0]
            : data?.contact;
          const who = contact?.name || contact?.phone || "Nuevo mensaje";
          const via = data?.channel === "messenger" ? "Messenger" : "WhatsApp";
          const body =
            msg.content_text?.trim() ||
            CONTENT_LABELS[msg.content_type] ||
            "Mensaje nuevo";

          const reg = await navigator.serviceWorker?.ready;
          const options: NotificationOptions = {
            body,
            icon: "/pwa-192.png",
            badge: "/pwa-192.png",
            // Misma conversación = reemplaza en vez de apilar.
            tag: `conv-${msg.conversation_id}`,
            data: { url: `/inbox?c=${msg.conversation_id}` },
          };
          if (reg) await reg.showNotification(`${who} · ${via}`, options);
          else new Notification(`${who} · ${via}`, options);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [permission]);

  return { permission, enable };
}
