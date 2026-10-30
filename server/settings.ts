import fs from "node:fs";
import type { AppSettings } from "../shared/types.js";
import { DATA_DIR, SETTINGS_FILE, ensureDir } from "./paths.js";

interface StoredSettings {
  anthropicApiKey?: string;
  model: string;
  effort: AppSettings["effort"];
  maxCreditsPerClip: number;
}

const DEFAULTS: StoredSettings = { model: "claude-opus-5-5", effort: "high", maxCreditsPerClip: 20 };

export function readSettings(): StoredSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(patch: Partial<StoredSettings>) {
  const next = { ...readSettings(), ...patch };
  if (next.anthropicApiKey === "") delete next.anthropicApiKey;
  ensureDir(DATA_DIR);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** The key saved in the app wins; otherwise the SDK falls back to ANTHROPIC_API_KEY. */
export function apiKey(): string | undefined {
  return readSettings().anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined;
}

export function publicSettings(): AppSettings {
  const s = readSettings();
  const key = apiKey();
  return {
    hasApiKey: Boolean(key),
    apiKeyHint: key ? key.slice(-4) : "",
    model: s.model,
    effort: s.effort,
    maxCreditsPerClip: s.maxCreditsPerClip,
  };
}
