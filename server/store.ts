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

export function deleteProject(id: string) {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}
