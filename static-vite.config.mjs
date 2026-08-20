import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "github-pages-spa",
    emptyOutDir: true,
    rollupOptions: {
      input: { index: path.resolve(process.cwd(), "static-index.html") },
    },
  },
});
