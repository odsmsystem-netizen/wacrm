// Service worker mínimo: solo atiende el clic en las notificaciones del
// sistema. No cachea nada a propósito (el CRM siempre debe cargar fresco).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || "/inbox";
  const target = new URL(path, self.location.origin).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Reusa la ventana abierta del CRM (instalada o pestaña) y la lleva
        // a la conversación; si no hay ninguna, abre una.
        for (const client of clients) {
          if ("focus" in client) {
            return client.focus().then((c) => ("navigate" in c ? c.navigate(target) : c));
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
