import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  optimizeDeps: {
    include: ["react", "react-dom", "zustand", "lucide-react", "tabulator-tables"],
  },
  worker: { format: "es" },
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: true,
    allowedHosts: true,
    warmup: {
      clientFiles: ["./src/main.tsx", "./src/boot.tsx", "./src/index.css", "./index.html"],
    },
    proxy: {
      "/sidecar": {
        target: "http://127.0.0.1:17831",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/sidecar/, ""),
      },
    },
  },
});
