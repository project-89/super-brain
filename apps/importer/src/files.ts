import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { extname } from "node:path";

export async function discoverJsonlFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && extname(entry.name) === ".jsonl") files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function fileMetadata(path: string): Promise<{ readonly byteLength: number; readonly modifiedAt: string }> {
  const metadata = await stat(path);
  return { byteLength: metadata.size, modifiedAt: metadata.mtime.toISOString() };
}
