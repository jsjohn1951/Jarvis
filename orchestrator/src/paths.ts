import { resolve, relative, isAbsolute } from "node:path";

/**
 * Resolve a (model-supplied, untrusted) relative path under `base`, returning the
 * absolute path only if it stays inside `base`. Returns null for anything that
 * escapes — absolute paths, `..` traversal, the base itself, or NUL bytes.
 */
export function safeResolveInBase(base: string, relPath: string): string | null {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\0") || isAbsolute(relPath))
    return null;
  const root = resolve(base);
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}
