import fs from "node:fs";
import type { AppSettings } from "../shared/types.js";
import { DATA_DIR, SETTINGS_FILE, ensureDir } from "./paths.js";

const DEFAULTS: AppSettings = { maxCreditsPerClip: 20 };

/** Only known settings are read and written, so anything stale in the file (like an old API key) is dropped. */
export function readSettings(): AppSettings {
  try {
    const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return { maxCreditsPerClip: Number.isInteger(stored.maxCreditsPerClip) ? stored.maxCreditsPerClip : DEFAULTS.maxCreditsPerClip };
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

/** Rewrite the settings file with only what the app uses (removes keys from older versions). */
export function cleanSettingsFile() {
  if (fs.existsSync(SETTINGS_FILE)) writeSettings({});
}
