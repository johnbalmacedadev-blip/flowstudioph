import path from "node:path";
import fs from "node:fs";

/** Everything the app writes lives under ./data (git-ignored). */
export const DATA_DIR = path.resolve(process.env.FSPH_DATA_DIR ?? "data");
export const PROJECTS_DIR = path.join(DATA_DIR, "projects");
export const CHROME_PROFILE_DIR = path.join(DATA_DIR, "chrome-profile");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export function projectDir(projectId: string) {
  return path.join(PROJECTS_DIR, safeId(projectId));
}
export function refsDir(projectId: string) {
  return path.join(projectDir(projectId), "refs");
}
export function rendersDir(projectId: string) {
  return path.join(projectDir(projectId), "renders");
}

/** Ids come from URLs; never let one escape the data folder. */
export function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid id: ${id}`);
  return id;
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
