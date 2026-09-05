import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "core", "src");
const target = path.join(root, "packages", "cli", "vendor", "core-src");

await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`core synced -> ${target}`);
