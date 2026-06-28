import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const thumbrellaClient = resolve(__dirname, "../../typescript");

export default defineConfig({
  srcDir: ".",
  server: { host: "0.0.0.0", port: 4333 },
  vite: {
    resolve: {
      alias: {
        "@thumbrella/client": thumbrellaClient,
      },
    },
    optimizeDeps: {
      include: ["@thumbrella/client"],
    },
  },
});
