import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Project, ProjectSummary } from "../shared/types.js";
import { PROJECTS_DIR, ensureDir, projectDir, refsDir, rendersDir } from "./paths.js";

export const newId = () => crypto.randomBytes(6).toString("hex");

function projectFile(id: string) {
  return path.join(projectDir(id), "project.json");
}

export function listProjects(): ProjectSummary[] {
  ensureDir(PROJECTS_DIR);
  return fs
    .readdirSync(PROJECTS_DIR)
    .flatMap((id) => {
      try {
        const p = getProject(id);
        return [{ id: p.id, name: p.name, updatedAt: p.updatedAt, sceneCount: p.scenes.length, characterCount: p.characters.length }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string): Project {
  return JSON.parse(fs.readFileSync(projectFile(id), "utf8"));
}

export function saveProject(p: Project): Project {
  p.updatedAt = new Date().toISOString();
  ensureDir(projectDir(p.id));
  // Write then rename so a crash mid-write never leaves a half-written project.
  const tmp = projectFile(p.id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, projectFile(p.id));
  return p;
}

export function createProject(name: string): Project {
  const now = new Date().toISOString();
  const p: Project = {
    id: newId(),
    name: name.trim() || "Untitled story",
    createdAt: now,
    updatedAt: now,
    settings: { aspectRatio: "16:9", seconds: 8, style: "" },
    script: "",
    logline: "",
    styleGuide: "",
    references: [],
    characters: [],
    scenes: [],
  };
  ensureDir(refsDir(p.id));
  ensureDir(rendersDir(p.id));
  return saveProject(p);
}

/** Read-modify-write in one step so concurrent jobs don't overwrite each other's changes. */
export function updateProject(id: string, fn: (p: Project) => void): Project {
  const p = getProject(id);
  fn(p);
  return saveProject(p);
}

/** Jobs live in memory, so after a restart nothing is really queued or running; say so instead of spinning forever. */
export function resetInterruptedRenders() {
  const note = "Interrupted because the app restarted. Render it again.";
  for (const { id } of listProjects()) {
    const p = getProject(id);
    const stuck = (s: string) => s === "queued" || s === "running";
    const statuses = [
      ...p.scenes.flatMap((s) => [s.imageStatus, s.videoStatus]),
      ...p.characters.map((c) => c.portraitStatus),
      ...(p.products ?? []).map((y) => y.shotStatus ?? "idle"),
    ];
    if (!statuses.some(stuck)) continue;
    updateProject(id, (x) => {
      for (const s of x.scenes) {
        if (stuck(s.imageStatus)) Object.assign(s, { imageStatus: "idle", error: note });
        if (stuck(s.videoStatus)) Object.assign(s, { videoStatus: "idle", error: note });
      }
      for (const c of x.characters) if (stuck(c.portraitStatus)) Object.assign(c, { portraitStatus: "idle", error: note });
      for (const y of x.products ?? []) if (y.shotStatus && stuck(y.shotStatus)) Object.assign(y, { shotStatus: "idle", error: note });
    });
  }
}

export function deleteProject(id: string) {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}
