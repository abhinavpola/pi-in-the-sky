type MemoryEntry =
  | {
      readonly kind: "dir";
      readonly children: Set<string>;
      readonly mtimeMs: number;
    }
  | {
      readonly kind: "file";
      readonly data: Uint8Array;
      readonly mtimeMs: number;
    };

class MemoryStats {
  readonly #entry: MemoryEntry;

  constructor(entry: MemoryEntry) {
    this.#entry = entry;
  }

  get size(): number {
    return this.#entry.kind === "file" ? this.#entry.data.byteLength : 0;
  }

  get mtimeMs(): number {
    return this.#entry.mtimeMs;
  }

  get ctimeMs(): number {
    return this.#entry.mtimeMs;
  }

  get mode(): number {
    return this.#entry.kind === "file" ? 0o100644 : 0o040000;
  }

  isFile(): boolean {
    return this.#entry.kind === "file";
  }

  isDirectory(): boolean {
    return this.#entry.kind === "dir";
  }

  isSymbolicLink(): boolean {
    return false;
  }
}

export class MemoryFS {
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  readonly #entries = new Map<string, MemoryEntry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ]);

  readonly promises = {
    readFile: (
      path: string,
      options?: string | { readonly encoding?: string },
    ) => this.readFile(path, options),
    writeFile: (path: string, data: string | Uint8Array | ArrayBuffer) =>
      this.writeFile(path, data),
    unlink: (path: string) => this.unlink(path),
    readdir: (path: string) => this.readdir(path),
    mkdir: (
      path: string,
      options?: { readonly recursive?: boolean } | number,
    ) => this.mkdir(path, options),
    rmdir: (path: string) => this.rmdir(path),
    stat: (path: string) => this.stat(path),
    lstat: (path: string) => this.lstat(path),
    readlink: (path: string) => this.readlink(path),
    symlink: (_target: string, path: string) => this.symlink(path),
  };

  #normalize(input: string): string {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") {
        continue;
      }
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return segments.length > 0 ? `/${segments.join("/")}` : "/";
  }

  #parent(path: string): string {
    const normalized = this.#normalize(path);
    if (normalized === "/") {
      return "/";
    }
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  #basename(path: string): string {
    return this.#normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  #requireEntry(path: string): MemoryEntry {
    const entry = this.#entries.get(this.#normalize(path));
    if (!entry) {
      const error = new Error(`ENOENT: ${path}`);
      Object.assign(error, { code: "ENOENT" });
      throw error;
    }
    return entry;
  }

  #requireDir(path: string): Extract<MemoryEntry, { readonly kind: "dir" }> {
    const entry = this.#requireEntry(path);
    if (entry.kind !== "dir") {
      const error = new Error(`ENOTDIR: ${path}`);
      Object.assign(error, { code: "ENOTDIR" });
      throw error;
    }
    return entry;
  }

  async mkdir(
    path: string,
    options?: { readonly recursive?: boolean } | number,
  ): Promise<void> {
    const target = this.#normalize(path);
    if (target === "/") {
      return;
    }
    const recursive =
      typeof options === "object" &&
      options !== null &&
      Boolean(options.recursive);
    const parentPath = this.#parent(target);
    if (!this.#entries.has(parentPath)) {
      if (!recursive) {
        const error = new Error(`ENOENT: ${parentPath}`);
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }
      await this.mkdir(parentPath, { recursive: true });
    }
    if (this.#entries.has(target)) {
      return;
    }
    this.#entries.set(target, {
      kind: "dir",
      children: new Set(),
      mtimeMs: Date.now(),
    });
    this.#requireDir(parentPath).children.add(this.#basename(target));
  }

  async writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
  ): Promise<void> {
    const target = this.#normalize(path);
    const parentPath = this.#parent(target);
    await this.mkdir(parentPath, { recursive: true });
    const bytes =
      typeof data === "string"
        ? this.#encoder.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    this.#entries.set(target, {
      kind: "file",
      data: bytes,
      mtimeMs: Date.now(),
    });
    this.#requireDir(parentPath).children.add(this.#basename(target));
  }

  async readFile(
    path: string,
    options?: string | { readonly encoding?: string },
  ): Promise<string | Uint8Array> {
    const entry = this.#requireEntry(path);
    if (entry.kind !== "file") {
      const error = new Error(`EISDIR: ${path}`);
      Object.assign(error, { code: "EISDIR" });
      throw error;
    }
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.#decoder.decode(entry.data) : entry.data;
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.#requireDir(path).children].sort();
  }

  async unlink(path: string): Promise<void> {
    const target = this.#normalize(path);
    const entry = this.#requireEntry(target);
    if (entry.kind !== "file") {
      const error = new Error(`EISDIR: ${path}`);
      Object.assign(error, { code: "EISDIR" });
      throw error;
    }
    this.#entries.delete(target);
    this.#requireDir(this.#parent(target)).children.delete(
      this.#basename(target),
    );
  }

  async rmdir(path: string): Promise<void> {
    const target = this.#normalize(path);
    const entry = this.#requireDir(target);
    if (entry.children.size > 0) {
      const error = new Error(`ENOTEMPTY: ${path}`);
      Object.assign(error, { code: "ENOTEMPTY" });
      throw error;
    }
    this.#entries.delete(target);
    this.#requireDir(this.#parent(target)).children.delete(
      this.#basename(target),
    );
  }

  async stat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.#requireEntry(path));
  }

  async lstat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.#requireEntry(path));
  }

  async readlink(path: string): Promise<string> {
    const error = new Error(`EINVAL: ${path}`);
    Object.assign(error, { code: "EINVAL" });
    throw error;
  }

  async symlink(path: string): Promise<void> {
    const error = new Error(`ENOSYS: ${path}`);
    Object.assign(error, { code: "ENOSYS" });
    throw error;
  }
}
