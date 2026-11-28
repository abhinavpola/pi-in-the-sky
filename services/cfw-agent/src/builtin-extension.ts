import builtinExtensionJson from "./generated/builtin-extension.json";

const BUILTIN_FILES = new Map<string, string>(
  Object.entries(builtinExtensionJson.files),
);

type SkillSummary = {
  readonly name: string;
  readonly path: string;
  readonly description: string;
};

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
  return builtinExtensionJson.skills;
}
