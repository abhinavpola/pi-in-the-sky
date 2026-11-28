import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const extensionRoot = path.join(repoRoot, "services", "cfw-agent", "extension");
const outputDir = path.join(
  repoRoot,
  "services",
  "cfw-agent",
  "src",
  "generated",
);
const outputFile = path.join(outputDir, "builtin-extension.json");

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

export async function bundleBuiltinExtension(): Promise<void> {
  const relativePaths = (await walk(extensionRoot)).sort();
  const bundled: Record<string, string> = {};
  for (const rel of relativePaths) {
    bundled[rel] = await readFile(path.join(extensionRoot, rel), "utf8");
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(bundled, null, 2)}\n`, "utf8");
}

if (import.meta.main) {
  await bundleBuiltinExtension();
}
