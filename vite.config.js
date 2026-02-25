import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import json from "@rollup/plugin-json";

export default defineConfig({
  plugins: [
    remix(),
    tsconfigPaths(),
    // Allows importing JSON files like Polaris translations in ESM
    json({ namedExports: true }),
  ],
  optimizeDeps: {
    include: ["@shopify/shopify-app-remix", "@shopify/polaris"],
  },
  ssr: {
    noExternal: ["@shopify/shopify-app-remix", "@shopify/polaris"],
  },
});
