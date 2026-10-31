import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppSettings } from "../shared/types.js";
import { DATA_DIR, SETTINGS_FILE, ensureDir } from "./paths.js";

/** Exports go to Videos\Flow Studio PH unless you choose another folder. */
export const DEFAULT_EXPORT_DIR = path.join(os.homedir(), "Videos", "Flow Studio PH");
const DEFAULTS: AppSettings = { maxCreditsPerClip: 20, exportDir: DEFAULT_EXPORT_DIR };

/** Only known settings are read and written, so anything stale in the file (like an old API key) is dropped. */
export function readSettings(): AppSettings {
  try {
    const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return {
      maxCreditsPerClip: Number.isInteger(stored.maxCreditsPerClip) ? stored.maxCreditsPerClip : DEFAULTS.maxCreditsPerClip,
      exportDir: typeof stored.exportDir === "string" && path.isAbsolute(stored.exportDir) ? stored.exportDir : DEFAULTS.exportDir,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(patch: Partial<AppSettings>) {
  const next = { ...readSettings(), ...patch };
  ensureDir(DATA_DIR);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

/**
 * Check a chosen export folder: it must be a full path (like D:\Videos\Ads), and it's created if missing.
 * Returns the cleaned path, or throws a message for people.
 */
export function checkExportDir(input: unknown): string {
  const dir = typeof input === "string" ? input.trim().replace(/^"|"$/g, "") : "";
  if (!dir) return DEFAULT_EXPORT_DIR;
  if (!path.isAbsolute(dir)) throw new Error("The export folder needs a full path, like C:\\Users\\you\\Videos\\Ads.");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`Can't save to ${dir}. Pick a folder you can write to.`);
  }
  return path.resolve(dir);
}

/** Rewrite the settings file with only what the app uses (removes keys from older versions). */
export function cleanSettingsFile() {
  if (fs.existsSync(SETTINGS_FILE)) writeSettings({});
}
