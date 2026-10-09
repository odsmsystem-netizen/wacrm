"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { canEditSettings } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import {
  decidirEstado,
  puedeAplicarGet,
  type EstadoToggle,
} from "@/lib/claudia/toggle-estado";

/**
 * Interruptor de Claudia en la barra superior — enciende/apaga el
 * agente de WhatsApp sin salir de la pantalla actual (PATCH optimista
 * sobre /api/claudia/config). Vive en el Header, a la izquierda del
 * ModeToggle, porque el usuario lo pidió ahí explícitamente.
 *
 * El punto no debe cambiar solo. Tres cosas lo hacían volver a verde:
 *  - el efecto dependía de `user`, que cambia de identidad con cada
 *    renovación de sesión, y volvía a consultar sin que nadie hiciera nada;
 *  - una consulta lenta podía llegar DESPUÉS de un clic y pisarlo;
 *  - una respuesta vacía o rara se pintaba como «activa».
 * Ahora el efecto depende de `user?.id`, un contador de versión descarta
 * las consultas que salieron antes de un clic, y solo un `activa`
 * booleano real cambia el color (ver toggle-estado.ts).
 */
export function ClaudiaToggle() {
  const t = useTranslations("Claudia.toggle");
  const { user, accountRole } = useAuth();
  const userId = user?.id ?? null;
  const [estado, setEstado] = useState<EstadoToggle>("cargando");
  const [pending, setPending] = useState(false);
  // Cuenta los clics (y los fines de PATCH). Una consulta solo se aplica
  // si la versión no cambió desde que salió.
  const versionRef = useRef(0);
  const patchPendienteRef = useRef(false);

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
    if (!userId) {
      setEstado("oculto");
      return;
    }
    let cancelado = false;

    const consultar = async () => {
      const versionAlSalir = versionRef.current;
      const aplicable = () =>
        !cancelado &&
        puedeAplicarGet({
          versionAlSalir,
          versionActual: versionRef.current,
          patchPendiente: patchPendienteRef.current,
        });
      try {
        const res = await fetch("/api/claudia/config");
        if (!aplicable()) return;
        if (!res.ok) {
          setEstado((prev) => decidirEstado(null, prev));
          return;
        }
        const data = await res.json().catch(() => null);
        if (!aplicable()) return;
        setEstado((prev) => decidirEstado(data, prev));
      } catch {
        // Falla en silencio: mejor un botón ausente (o el estado de
        // antes) que una barra superior rota en todo el panel.
        if (aplicable()) setEstado((prev) => decidirEstado(null, prev));
      }
    };

    void consultar();
    // Al volver a la pestaña se relee: otro administrador pudo cambiarlo.
    const alVolver = () => {
      if (document.visibilityState === "visible") void consultar();
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      cancelado = true;
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [userId]);

  const handleClick = useCallback(async () => {
    if (!canEdit || pending || estado === "cargando" || estado === "oculto") return;

    const anterior = estado;
    const siguiente = anterior === "activa" ? "inactiva" : "activa";
    // Cualquier consulta en vuelo describe el estado de antes del clic.
    versionRef.current += 1;
    patchPendienteRef.current = true;
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEstado(anterior);
        toast.error(data.error ?? t("toggleFailed"));
        return;
      }
      // Se adopta lo que DEVUELVE el servidor, no lo que supusimos. Si
      // la respuesta no trae un booleano, se vuelve al estado de antes.
      setEstado(decidirEstado(data, anterior));
    } catch {
      setEstado(anterior);
      toast.error(t("toggleFailed"));
    } finally {
      patchPendienteRef.current = false;
      // Una consulta que salió durante el PATCH ya no es aplicable.
      versionRef.current += 1;
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
