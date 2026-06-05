import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  // serve.ts resolves its web assets at join(__dirname, "web"); __dirname is dist/ once bundled,
  // so copy the static UI into dist/web after each build.
  onSuccess: "rm -rf dist/web && cp -r src/server/web dist/web",
})
