"use client";

import { useCallback, useEffect, useState } from "react";

// `beforeinstallprompt` no está en los tipos DOM estándar (solo Chromium).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Expone la instalación de la PWA. `canInstall` es true solo cuando el
 * navegador ofreció instalar (Chrome/Edge) y la app aún no está instalada;
 * en Safari/Firefox o ya instalada queda en false y no se muestra nada.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    // El evento solo sirve una vez, acepte o no.
    setDeferred(null);
  }, [deferred]);

  return { canInstall: deferred !== null, install };
}
