// Types shared by the server and the web UI.

/** Clip lengths Flow offers. "auto" lets the storyboard pick per scene from this list. */
export const DURATIONS = [4, 6, 8, 10] as const;
export type Duration = (typeof DURATIONS)[number];
export type SecondsSetting = Duration | "auto";

export type AspectRatio = "16:9" | "9:16";

export type ReferenceKind = "character" | "location" | "style" | "prop";

export interface Reference {
  id: string;
  /** What the user calls it, e.g. "Maria" or "Old market". The storyboard matches on this. */
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
  /**
   * Same place and moment as the scene before: its frame is matched to the previous frame, and its clip
   * starts on the previous clip's last frame, so the cut is seamless.
   */
  continuesPrevious: boolean;
  imageStatus: RenderStatus;
  imageFile?: string;
  videoStatus: RenderStatus;
  videoFile?: string;
  /** Flow's id for the clip, so its 1080p upscale can be fetched later. */
  videoFlowId?: string;
  /** Flow's 1080p upscale of videoFile, fetched the first time a 1080p+ export needs it. */
  videoHdFile?: string;
  error?: string;
}

/** One clip on the Final Cut timeline: a scene's rendered clip, trimmed to [inSec, outSec]. */
export interface CutItem {
  id: string;
  sceneId: string;
  /** The scene's clip when it was added; a re-render replaces it and resets the trim. */
  file: string;
  duration: number;
  inSec: number;
  outSec: number;
}

export interface FinalCut {
  items: CutItem[];
  /** Taken off the timeline; kept so they can be put back. */
  removed: CutItem[];
}

export const EXPORT_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
export type ExportResolution = (typeof EXPORT_RESOLUTIONS)[number];

export interface ExportFile {
  file: string;
  resolution: ExportResolution;
  width: number;
  height: number;
  duration: number;
  sizeBytes: number;
  createdAt: string;
}

/**
 * How the script becomes a storyboard. None needs an API key:
 * "flow" asks Google Flow's own agent (Gemini) in your signed-in account; "local" is a quick split on this computer;
 * "claude" is written by Claude Code in this repo (the storyboard skill) and loaded through the import endpoint.
 */
export type StoryboardEngine = "flow" | "local" | "claude";

export interface ProjectSettings {
  aspectRatio: AspectRatio;
  seconds: SecondsSetting;
  style: string;
  /** Missing on older projects: treated as "flow". */
  engine?: StoryboardEngine;
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
  finalCut?: FinalCut;
  exports?: ExportFile[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  sceneCount: number;
  characterCount: number;
}

export interface AppSettings {
  /** A render is skipped if Flow quotes more credits than this. */
  maxCreditsPerClip: number;
}

export type JobKind = "breakdown" | "portrait" | "image" | "video" | "export";

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
  /** Whether the Flow Chrome window is on screen (it normally runs hidden). */
  windowVisible: boolean;
  url: string;
  message: string;
}
