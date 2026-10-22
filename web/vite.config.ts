import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// `vite build --mode demo` makes a self-contained preview (no server, example data).
export default defineConfig(({ mode }) => ({
  plugins: [preact()],
  define: { __DEMO__: JSON.stringify(mode === "demo") },
  build: {
    target: "es2020",
    outDir: mode === "demo" ? "dist-demo" : "dist",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: mode === "demo" ? 100_000_000 : 4096,
    cssCodeSplit: false,
    copyPublicDir: mode !== "demo",
    rollupOptions: mode === "demo" ? { output: { inlineDynamicImports: true } } : {},
  },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787", "/cal": "http://localhost:8787" } },
}));
