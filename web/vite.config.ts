import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// An empty DESK_API means unset.
const api = (process.env.DESK_API ?? "") || "http://127.0.0.1:47823";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": api, "/health": api } },
});
