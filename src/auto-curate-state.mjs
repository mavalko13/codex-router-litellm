import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const AUTO_CURATE_PENDING_PATH = path.join(STATE_DIR, "auto-curate-refresh.pending");

export function autoCurateRefreshPending() {
  return existsSync(AUTO_CURATE_PENDING_PATH);
}

export function periodicAutoCurateAction({ summary, pending }) {
  if (pending) return "restart";
  return summary ? "idle" : "failed";
}

export function markAutoCurateRefreshPending() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${AUTO_CURATE_PENDING_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, "1\n", { encoding: "utf8", mode: 0o600 });
  protectPrivateFile(temporary);
  renameSync(temporary, AUTO_CURATE_PENDING_PATH);
  protectPrivateFile(AUTO_CURATE_PENDING_PATH);
}

export function clearAutoCurateRefreshPending() {
  if (existsSync(AUTO_CURATE_PENDING_PATH)) unlinkSync(AUTO_CURATE_PENDING_PATH);
}
