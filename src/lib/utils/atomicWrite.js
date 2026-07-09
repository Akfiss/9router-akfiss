import fs from "fs/promises";
import path from "path";

/**
 * Write file atomically by writing to a temp file then renaming.
 * Prevents config corruption if process crashes during write.
 *
 * @param {string} filePath - Final file path
 * @param {string} content - Content to write
 * @param {{ mode?: number }} [options] - File mode (e.g. 0o600 for credentials)
 */
export async function atomicWriteFile(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = filePath + ".tmp-" + process.pid;
  await fs.writeFile(tempPath, content, "utf-8");

  if (options.mode !== undefined) {
    await fs.chmod(tempPath, options.mode);
  }

  await fs.rename(tempPath, filePath);
}
