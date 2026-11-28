import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const extensionRoot = path.join(repoRoot, "services", "cfw-agent", "extension");
const outputFile = path.join(
  repoRoot,
  "services",
  "cfw-agent",
  "src",
  "generated",
  "builtin-extension.json",
);

export async function bundleBuiltinExtension(): Promise<void> {
  const relativePaths = (
    await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: extensionRoot, onlyFiles: true }),
    )
  ).sort();
  const bundled: Record<string, string> = {};
  for (const rel of relativePaths) {
    bundled[rel] = await Bun.file(path.join(extensionRoot, rel)).text();
  }
  await Bun.write(outputFile, `${JSON.stringify(bundled, null, 2)}\n`);
}

if (import.meta.main) {
  await bundleBuiltinExtension();
}
