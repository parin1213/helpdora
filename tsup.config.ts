import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  minify: false,
  sourcemap: false,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  splitting: false,
  shims: false,
});
