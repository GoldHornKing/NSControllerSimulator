import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import {
  createFirmwareManifest,
  listFirmwareVariants,
  readFirmwareFlashPlan,
} from "./scripts/firmware-site.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function firmwareDevPlugin() {
  const variants = listFirmwareVariants();
  const variantByManifestPath = new Map(
    variants.map((variant) => [`/firmware/${variant.manifestFileName}`, variant]),
  );
  const variantByEnvironmentId = new Map(
    variants.map((variant) => [variant.environmentId, variant]),
  );

  return {
    name: "friend-maker-firmware-dev",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
        const manifestVariant = variantByManifestPath.get(url);

        if (manifestVariant) {
          try {
            const manifest = await createFirmwareManifest(manifestVariant.switchModelId);
            response.statusCode = 200;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(`${JSON.stringify(manifest, null, 2)}\n`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            response.statusCode = 503;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(`${JSON.stringify({ error: message }, null, 2)}\n`);
          }
          return;
        }

        const match = /^\/firmware\/([^/]+)\/([^/]+)$/u.exec(url);
        const environmentId = match?.[1];
        const publishFileName = match?.[2];
        if (!environmentId || !publishFileName) {
          next();
          return;
        }

        const variant = variantByEnvironmentId.get(environmentId);
        if (!variant) {
          next();
          return;
        }

        const firmwareParts = await readFirmwareFlashPlan(variant.switchModelId);
        const part = firmwareParts.find((entry) => entry.publishFileName === publishFileName);
        if (!part) {
          response.statusCode = 404;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(`${JSON.stringify({ error: `Unknown firmware file: ${publishFileName}` })}\n`);
          return;
        }

        if (!existsSync(part.sourcePath)) {
          response.statusCode = 404;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(`${JSON.stringify({ error: `Missing firmware file: ${part.publishFileName}` })}\n`);
          return;
        }

        try {
          const content = await readFile(part.sourcePath);
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/octet-stream");
          response.end(content);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(`${JSON.stringify({ error: message })}\n`);
        }
      });
    },
  };
}

export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [firmwareDevPlugin()],
  build: {
    outDir: path.resolve(__dirname, "dist", "web"),
    emptyOutDir: true,
  },
});
