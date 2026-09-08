"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { canEditSettings } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";

/**
 * Estado local del interruptor. "oculto" cubre tanto "sin sesión" como
 * "la petición falló" — en ambos casos el componente no debe pintar
 * nada (ver comentario en el return más abajo): el header se monta en
 * TODAS las páginas del panel y no puede depender de este fetch.
 */
type Estado = "cargando" | "activa" | "inactiva" | "oculto";

/**
 * Interruptor de Claudia en la barra superior — enciende/apaga el
 * agente de WhatsApp sin salir de la pantalla actual (PATCH optimista
 * sobre /api/claudia/config). Vive en el Header, a la izquierda del
 * ModeToggle, porque el usuario lo pidió ahí explícitamente.
 */
export function ClaudiaToggle() {
  const t = useTranslations("Claudia.toggle");
  const { user, accountRole } = useAuth();
  const [estado, setEstado] = useState<Estado>("cargando");
  const [pending, setPending] = useState(false);

  // `accountRole` es null mientras el perfil no resuelve, así que
  // `canEdit` empieza en false y solo se vuelve true cuando de verdad
  // sabemos que el usuario es admin+ — no hace falta un flag de carga
  // aparte para deshabilitar el botón mientras tanto.
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  useEffect(() => {
    // Sin sesión no hay nada que consultar (y la API respondería 401
    // de todas formas). El shell del dashboard solo monta el Header
    // una vez que hay usuario, pero este chequeo es barato y evita
    // depender de ese orden de montaje.
    if (!user) {
      setEstado("oculto");
      return;
    }
    let cancelado = false;
    (async () => {
      try {
        const res = await fetch("/api/claudia/config");
        if (!res.ok) {
          if (!cancelado) setEstado("oculto");
          return;
        }
        const data = await res.json().catch(() => null);
        if (cancelado) return;
        setEstado(data?.activa === false ? "inactiva" : "activa");
      } catch {
        // Falla en silencio: mejor un botón ausente que una barra
        // superior rota en todo el panel.
        if (!cancelado) setEstado("oculto");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [user]);

  const handleClick = useCallback(async () => {
    if (!canEdit || pending || estado === "cargando" || estado === "oculto") return;

    const anterior = estado;
    const siguiente = anterior === "activa" ? "inactiva" : "activa";
    // Optimista: el color cambia al instante. Un PATCH que tarda un
    // segundo no debe congelar la barra superior en cada clic.
    setEstado(siguiente);
    setPending(true);
    try {
      const res = await fetch("/api/claudia/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activa: siguiente === "activa" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEstado(anterior);
        toast.error(data.error ?? t("toggleFailed"));
      }
    } catch {
      setEstado(anterior);
      toast.error(t("toggleFailed"));
    } finally {
      setPending(false);
    }
  }, [canEdit, pending, estado, t]);

  // Sin sesión o con el fetch fallido: nada. Ver comentario del tipo
  // `Estado` arriba.
  if (estado === "oculto") return null;

  const cargando = estado === "cargando";
  const label = cargando
    ? t("loading")
    : estado === "activa"
      ? canEdit
        ? t("active")
        : t("activeReadOnly")
      : canEdit
        ? t("inactive")
        : t("inactiveReadOnly");

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!canEdit || cargando}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors",
        canEdit && !cargando
          ? "hover:bg-muted hover:text-foreground"
          : "cursor-not-allowed",
      )}
    >
      {/* Rojo = apagada es una afirmación fuerte, así que mientras no
          sepamos el estado real usamos gris — nunca rojo por defecto. */}
      <span
        className={cn(
          "block h-2.5 w-2.5 rounded-full transition-colors",
          cargando
            ? "bg-muted-foreground/40"
            : estado === "activa"
              ? "bg-emerald-500"
              : "bg-red-500",
        )}
      />
    </button>
  );
}
