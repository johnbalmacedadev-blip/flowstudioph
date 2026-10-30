import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = Number(process.env.FSPH_API_PORT ?? 5174);

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/files": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
