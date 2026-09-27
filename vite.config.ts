import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    {
      name: "vite-envdir-compat",
      enforce: "post",
      config(config) {
        // React Router currently emits Vite's removed `envFile: false` option.
        // Vite 8 renamed it to `envDir: false`; normalize it after plugins run.
        delete (config as typeof config & { envFile?: boolean }).envFile;
        return { envDir: false };
      },
    },
  ],
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    // Ships a raw CSS side-effect import (styles.css); without this, Vite's
    // SSR module graph passes it straight to Node's ESM loader instead of
    // transforming it, which throws ERR_UNKNOWN_FILE_EXTENSION on ".css".
    noExternal: ["@shopify/polaris-viz"],
  },
  server: {
    // Bind to 0.0.0.0 so the Windows host browser can reach the dev server
    // running inside WSL (localhost forwarding needs an all-interfaces bind).
    host: true,
    port: 5173,
  },
});
