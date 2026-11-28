import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export async function bundleBuiltinExtension(): Promise<void> {
  const relativePaths = (
    await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: extensionRoot, onlyFiles: true }),
    )
  ).sort();
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
