import { defineConfig } from "astro/config";

export default defineConfig({
  server: { host: "0.0.0.0", port: 4333 },
  vite: {
    server: {
      proxy: {
        "/api": {
          target: "http://localhost:3114",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  },
});
