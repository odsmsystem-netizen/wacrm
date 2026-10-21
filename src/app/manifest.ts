import type { MetadataRoute } from "next";

// Web app manifest: lo que hace al CRM instalable como app de escritorio
// (Chrome/Edge) o en la pantalla de inicio del teléfono.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ambar CRM",
    short_name: "Ambar CRM",
    description: "CRM de WhatsApp de Ambar Cargo.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#020617",
    icons: [
      { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/pwa-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
