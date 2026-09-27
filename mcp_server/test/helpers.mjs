import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { childEnvironment } from "../src/runtime.mjs";
export const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
export async function fixture() {
  const base = path.join(workspaceRoot, ".tmp/t"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "test-")); const shell = path.join(root, "shell.sh");
  await writeFile(shell, '#!/bin/bash\nexec /bin/bash --noprofile --norc -c "$2"\n'); await chmod(shell, 0o700);
  return { root, shell, env: { ...childEnvironment(workspaceRoot), MCP_BOTMUX_ENABLED: '0' }, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}
