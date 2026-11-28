import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { bundleBuiltinExtension } from "./bundle-builtin-extension";

await bundleBuiltinExtension();

const repoRoot = path.resolve(import.meta.dirname, "..");
const workerDir = path.join(repoRoot, "services", "cfw-agent");
const outputDir = path.join(repoRoot, "packages", "client", "generated");
const outputFile = path.join(outputDir, "worker-bundle.json");

const tempDir = await mkdtemp(path.join(tmpdir(), "pi-in-the-sky-worker-"));

try {
  const proc = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "deploy",
      "--dry-run",
      "--minify",
      "--outdir",
      tempDir,
    ],
    {
      cwd: workerDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    process.stderr.write(
      `Failed to bundle Worker (exit ${exitCode}):\n${stdout}\n${stderr}\n`,
    );
    process.exit(exitCode);
  }

  const code = await readFile(path.join(tempDir, "index.js"), "utf8");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputFile, JSON.stringify({ code }), "utf8");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
