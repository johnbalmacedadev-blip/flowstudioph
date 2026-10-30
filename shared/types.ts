// Types shared by the server and the web UI.

/** Clip lengths Flow offers. "auto" lets Claude pick per scene from this list. */
export const DURATIONS = [4, 6, 8, 10] as const;
export type Duration = (typeof DURATIONS)[number];
export type SecondsSetting = Duration | "auto";

export type AspectRatio = "16:9" | "9:16";

export type ReferenceKind = "character" | "location" | "style" | "prop";

export interface Reference {
  id: string;
  /** What the user calls it, e.g. "Maria" or "Old market". Claude matches on this. */
  label: string;
  kind: ReferenceKind;
  file: string; // file name inside the project's refs folder
  mime: string;
}

export type RenderStatus = "idle" | "queued" | "running" | "done" | "failed";

export interface Character {
  id: string;
  name: string;
  role: string;
  description: string;
  /** Full visual description, repeated in every prompt so the look stays consistent. */
  visualPrompt: string;
  referenceIds: string[];
  portraitStatus: RenderStatus;
  portraitFile?: string;
  error?: string;
}

export interface Scene {
  id: string;
  number: number;
  title: string;
  durationSec: Duration;
  location: string;
  characterIds: string[];
  action: string;
  shot: string;
  imagePrompt: string;
  videoPrompt: string;
  dialogue: string;
  sound: string;
  imageStatus: RenderStatus;
  imageFile?: string;
  videoStatus: RenderStatus;
  videoFile?: string;
  error?: string;
}

export interface ProjectSettings {
  aspectRatio: AspectRatio;
  seconds: SecondsSetting;
  style: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
  script: string;
  logline: string;
  styleGuide: string;
  references: Reference[];
  characters: Character[];
  scenes: Scene[];
  /** The Flow project this one renders into; created on the first render. */
  flowProjectUrl?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  sceneCount: number;
  characterCount: number;
}

export interface AppSettings {
  hasApiKey: boolean;
  apiKeyHint: string; // last 4 characters, never the key itself
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** A render is skipped if Flow quotes more credits than this. */
  maxCreditsPerClip: number;
}

export type JobKind = "breakdown" | "portrait" | "image" | "video";

export interface Job {
  id: string;
  kind: JobKind;
  projectId: string;
  targetId?: string; // scene or character id
  label: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface FlowStatus {
  browserOpen: boolean;
  signedIn: boolean;
  url: string;
  message: string;
}
