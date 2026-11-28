import builtinExtensionJson from "./generated/builtin-extension.json";

const BUILTIN_FILES = new Map<string, string>(
  Object.entries(builtinExtensionJson),
);

type SkillSummary = {
  readonly name: string;
  readonly path: string;
  readonly description: string;
};

function parseFrontmatterField(content: string, field: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) {
    return null;
  }
  const line = match[1]
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${field}:`));
  if (!line) {
    return null;
  }
  const value = line.slice(field.length + 1).trim();
  return value.replace(/^["']|["']$/g, "");
}

export function getBuiltinExtensionFiles(): ReadonlyMap<string, string> {
  return BUILTIN_FILES;
}

export function getBuiltinExtensionFile(relativePath: string): string | null {
  return BUILTIN_FILES.get(relativePath) ?? null;
}

export function mergeExtensionFileListing(
  repoFiles: readonly string[],
): readonly {
  readonly path: string;
  readonly repoPath: string;
  readonly source: "builtin" | "override" | "user";
}[] {
  const byPath = new Map<
    string,
    {
      readonly path: string;
      readonly repoPath: string;
      readonly source: "builtin" | "override" | "user";
    }
  >();
  for (const relPath of BUILTIN_FILES.keys()) {
    byPath.set(relPath, {
      path: relPath,
      repoPath: `extension/${relPath}`,
      source: "builtin",
    });
  }
  for (const relPath of repoFiles) {
    byPath.set(relPath, {
      path: relPath,
      repoPath: `extension/${relPath}`,
      source: byPath.has(relPath) ? "override" : "user",
    });
  }
  return Array.from(byPath.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

export function listBuiltinSkills(): readonly SkillSummary[] {
  const skills: SkillSummary[] = [];
  for (const [relativePath, content] of BUILTIN_FILES) {
    const match = relativePath.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (!match?.[1]) {
      continue;
    }
    const name = parseFrontmatterField(content, "name") ?? match[1];
    const description =
      parseFrontmatterField(content, "description") ??
      `Built-in skill (${relativePath}).`;
    skills.push({ name, path: relativePath, description });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
