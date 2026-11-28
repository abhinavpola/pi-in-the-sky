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

function extractFrontmatter(content: string): {
  readonly name?: string;
  readonly description?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) {
    return {};
  }
  const parsed: unknown = Bun.YAML.parse(match[1]);
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const name =
    "name" in parsed && typeof parsed.name === "string"
      ? parsed.name.trim()
      : undefined;
  const description =
    "description" in parsed && typeof parsed.description === "string"
      ? parsed.description.trim()
      : undefined;
  return { name, description };
}

export async function bundleBuiltinExtension(): Promise<void> {
  const relativePaths = (
    await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: extensionRoot, onlyFiles: true }),
    )
  ).sort();
  const files: Record<string, string> = {};
  const skills: {
    readonly name: string;
    readonly path: string;
    readonly description: string;
  }[] = [];

  for (const rel of relativePaths) {
    const content = await Bun.file(path.join(extensionRoot, rel)).text();
    files[rel] = content;
    const skillMatch = rel.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (skillMatch?.[1]) {
      const fm = extractFrontmatter(content);
      skills.push({
        name: fm.name ?? skillMatch[1],
        path: rel,
        description: fm.description ?? `Built-in skill (${rel}).`,
      });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  await Bun.write(
    outputFile,
    `${JSON.stringify({ files, skills }, null, 2)}\n`,
  );
}

if (import.meta.main) {
  await bundleBuiltinExtension();
}
