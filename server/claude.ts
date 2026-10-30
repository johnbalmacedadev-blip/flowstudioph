import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { DURATIONS, type Character, type Duration, type Project, type Scene } from "../shared/types.js";
import { refsDir } from "./paths.js";
import { apiKey, readSettings } from "./settings.js";
import { newId } from "./store.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface Breakdown {
  title: string;
  logline: string;
  style_guide: string;
  characters: {
    name: string;
    role: string;
    description: string;
    visual_prompt: string;
    reference_labels: string[];
  }[];
  scenes: {
    title: string;
    duration_seconds: number;
    location: string;
    characters: string[];
    action: string;
    shot: string;
    image_prompt: string;
    video_prompt: string;
    dialogue: string;
    sound: string;
  }[];
}

const str = { type: "string" } as const;

function breakdownSchema(allowed: readonly number[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "logline", "style_guide", "characters", "scenes"],
    properties: {
      title: str,
      logline: str,
      style_guide: str,
      characters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "role", "description", "visual_prompt", "reference_labels"],
          properties: {
            name: str,
            role: str,
            description: str,
            visual_prompt: str,
            reference_labels: { type: "array", items: str },
          },
        },
      },
      scenes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "title", "duration_seconds", "location", "characters", "action",
            "shot", "image_prompt", "video_prompt", "dialogue", "sound",
          ],
          properties: {
            title: str,
            duration_seconds: { type: "integer", enum: [...allowed] },
            location: str,
            characters: { type: "array", items: str },
            action: str,
            shot: str,
            image_prompt: str,
            video_prompt: str,
            dialogue: str,
            sound: str,
          },
        },
      },
    },
  };
}

const SYSTEM = `You are a storyboard artist and prompt writer for Google Flow, an AI video tool that makes one short clip per prompt.

You receive a script, a story idea, a workflow, or a long "master prompt", plus optional reference images. Turn it into a cast of characters and an ordered list of scenes, where each scene is exactly one continuous shot that Flow will render as one clip.

Rules:
- Keep everything the source asks for. If it already lists scenes, shots or timings, follow them in order and do not merge, drop or reorder them. If it is prose, break it into shots that tell the whole story.
- Each scene's action must fit its duration_seconds. Split a long beat across several scenes rather than cramming it into one.
- Flow has no memory between clips. Every image_prompt and video_prompt must stand alone: repeat each character's full visual description, the location, and the style in every prompt that uses them. Never write "the same man" or "as before".
- image_prompt describes the opening still frame of the shot (composition, characters, setting, style, lighting). video_prompt describes the motion over the clip: subject and action, then shot size and one camera move, then location, style, lighting, and sound. Put spoken lines in quotes and say who speaks them.
- Write prompts in English even if the source is in another language; keep dialogue in the language the source uses.
- style_guide is one paragraph describing the shared visual style. Fold it into every prompt.
- For reference images, use reference_labels to link a character to the labels of the images that show them, and match their visual_prompt to what the image shows.
- characters lists only recurring or named people, creatures or mascots. Use the exact same name in each scene's characters list.
- dialogue and sound may be empty strings when there is none.`;

export interface BreakdownProgress {
  (message: string): void;
}

export async function breakdownScript(project: Project, onProgress: BreakdownProgress) {
  const key = apiKey();
  if (!key) throw new Error("Add your Anthropic API key in Settings first.");
  if (!project.script.trim()) throw new Error("Paste a script or master prompt first.");

  const { model, effort } = readSettings();
  const client = new Anthropic({ apiKey: key });
  const seconds = project.settings.seconds;
  const allowed: readonly number[] = seconds === "auto" ? DURATIONS : [seconds];

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const skipped: string[] = [];
  for (const ref of project.references) {
    const file = path.join(refsDir(project.id), ref.file);
    if (!IMAGE_TYPES.has(ref.mime) || !fs.existsSync(file) || fs.statSync(file).size > MAX_IMAGE_BYTES) {
      skipped.push(ref.label);
      continue;
    }
    content.push({ type: "text", text: `Reference image "${ref.label}" (${ref.kind}):` });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: ref.mime as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data: fs.readFileSync(file).toString("base64"),
      },
    });
  }

  const timing =
    seconds === "auto"
      ? `Choose each scene's duration from ${DURATIONS.join(", ")} seconds to fit its action.`
      : `Every scene is ${seconds} seconds long; plan each shot's action to fill exactly ${seconds} seconds.`;

  content.push({
    type: "text",
    text: [
      `Project: ${project.name}`,
      `Aspect ratio: ${project.settings.aspectRatio}`,
      project.settings.style ? `Requested visual style: ${project.settings.style}` : "",
      timing,
      skipped.length ? `(Some references could not be attached: ${skipped.join(", ")}.)` : "",
      "",
      "<source>",
      project.script,
      "</source>",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  });

  onProgress("Sending the script to Claude…");
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema: breakdownSchema(allowed) } },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });

  let chars = 0;
  let lastReport = 0;
  stream.on("text", (delta) => {
    chars += delta.length;
    const scenes = (chars / 900) | 0; // rough: a scene is ~900 characters of JSON
    if (Date.now() - lastReport > 1000) {
      lastReport = Date.now();
      onProgress(`Writing the storyboard… (~${scenes} scenes so far)`);
    }
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined to break down this script. Try rewording the parts it may have flagged.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The storyboard was too long to finish in one go. Split the script into parts and run each one.");
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const result = JSON.parse(text) as Breakdown;
  onProgress(`Got ${result.characters.length} characters and ${result.scenes.length} scenes.`);
  return { result, skipped };
}

/** Replace the project's cast and scenes with a fresh breakdown. */
export function applyBreakdown(project: Project, b: Breakdown) {
  const refByLabel = new Map(project.references.map((r) => [r.label.toLowerCase(), r.id]));
  const characters: Character[] = b.characters.map((c) => ({
    id: newId(),
    name: c.name,
    role: c.role,
    description: c.description,
    visualPrompt: c.visual_prompt,
    referenceIds: c.reference_labels.flatMap((l) => refByLabel.get(l.toLowerCase()) ?? []),
    portraitStatus: "idle",
  }));
  const charByName = new Map(characters.map((c) => [c.name.toLowerCase(), c.id]));
  const fallbackDuration: Duration = project.settings.seconds === "auto" ? 8 : project.settings.seconds;
  const scenes: Scene[] = b.scenes.map((s, i) => ({
    id: newId(),
    number: i + 1,
    title: s.title,
    durationSec: (DURATIONS as readonly number[]).includes(s.duration_seconds)
      ? (s.duration_seconds as Duration)
      : fallbackDuration,
    location: s.location,
    characterIds: s.characters.flatMap((n) => charByName.get(n.toLowerCase()) ?? []),
    action: s.action,
    shot: s.shot,
    imagePrompt: s.image_prompt,
    videoPrompt: s.video_prompt,
    dialogue: s.dialogue,
    sound: s.sound,
    imageStatus: "idle",
    videoStatus: "idle",
  }));
  project.logline = b.logline;
  project.styleGuide = b.style_guide;
  project.characters = characters;
  project.scenes = scenes;
  if (!project.name || project.name === "Untitled story") project.name = b.title;
}
