import { rm } from "node:fs/promises";
import { build } from "esbuild";

// 清理旧产物：esbuild 不会删除过期输出（如曾开启 sourcemap 时遗留的 .map），避免其随 VSIX 发布
await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: false,
  minify: true, // T12 生产构建开 minify
});
console.log("built dist/extension.js");
