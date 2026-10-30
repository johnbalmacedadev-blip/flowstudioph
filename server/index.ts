import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { DURATIONS, type Character, type Project, type ReferenceKind, type Scene } from "../shared/types.js";
import { applyBreakdown, breakdownScript } from "./claude.js";
import { flowStatus, openFlow } from "./flow/browser.js";
import { renderPortrait, renderSceneImage, renderSceneVideo } from "./flow/driver.js";
import { cancelJob, listJobs, queueFlowJob, startJob } from "./jobs.js";
import { PROJECTS_DIR, ensureDir, refsDir, safeId } from "./paths.js";
import { publicSettings, writeSettings } from "./settings.js";
import {
  createProject, deleteProject, getProject, listProjects, newId, updateProject,
} from "./store.js";

const PORT = Number(process.env.FSPH_API_PORT ?? 5174);
const app = express();
app.use(express.json({ limit: "5mb" }));

const KINDS: ReferenceKind[] = ["character", "location", "style", "prop"];
const pick = <T extends object>(src: any, keys: (keyof T)[]) =>
  Object.fromEntries(keys.filter((k) => src?.[k] !== undefined).map((k) => [k, src[k]])) as Partial<T>;

// ---- settings ----
app.get("/api/settings", (_req, res) => res.json(publicSettings()));
app.put("/api/settings", (req, res) => {
  const { apiKey, model, effort, maxCreditsPerClip } = req.body ?? {};
  writeSettings({
    ...(typeof apiKey === "string" ? { anthropicApiKey: apiKey.trim() } : {}),
    ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}),
    ...(["low", "medium", "high", "xhigh", "max"].includes(effort) ? { effort } : {}),
    ...(Number.isInteger(maxCreditsPerClip) && maxCreditsPerClip >= 0 ? { maxCreditsPerClip } : {}),
  });
  res.json(publicSettings());
});

// ---- projects ----
app.get("/api/projects", (_req, res) => res.json(listProjects()));
app.post("/api/projects", (req, res) => res.json(createProject(String(req.body?.name ?? ""))));
app.get("/api/projects/:id", (req, res) => res.json(getProject(safeId(req.params.id))));
app.put("/api/projects/:id", (req, res) => {
  const body = req.body ?? {};
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      Object.assign(p, pick<Project>(body, ["name", "script", "logline", "styleGuide"]));
      if (body.settings) {
        const s = body.settings;
        if (s.aspectRatio === "16:9" || s.aspectRatio === "9:16") p.settings.aspectRatio = s.aspectRatio;
        if (s.seconds === "auto" || DURATIONS.includes(s.seconds)) p.settings.seconds = s.seconds;
        if (typeof s.style === "string") p.settings.style = s.style;
      }
    }),
  );
});
app.delete("/api/projects/:id", (req, res) => {
  deleteProject(safeId(req.params.id));
  res.json({ ok: true });
});

// ---- references ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, ensureDir(refsDir(safeId(String(req.params.id))))),
    filename: (_req, file, cb) => cb(null, `${newId()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
});

app.post("/api/projects/:id/references", upload.array("files", 20), (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  const kind = KINDS.includes(req.body.kind) ? (req.body.kind as ReferenceKind) : "character";
  res.json(
    updateProject(safeId(String(req.params.id)), (p) => {
      for (const f of files) {
        const base = path.parse(f.originalname).name.replace(/[_-]+/g, " ").trim();
        p.references.push({
          id: newId(),
          label: (files.length === 1 && req.body.label?.trim()) || base || "Reference",
          kind,
          file: f.filename,
          mime: f.mimetype,
        });
      }
    }),
  );
});
app.put("/api/projects/:id/references/:refId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const r = p.references.find((x) => x.id === req.params.refId);
      if (!r) return;
      if (typeof req.body.label === "string") r.label = req.body.label.trim() || r.label;
      if (KINDS.includes(req.body.kind)) r.kind = req.body.kind;
    }),
  );
});
app.delete("/api/projects/:id/references/:refId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const r = p.references.find((x) => x.id === req.params.refId);
      if (!r) return;
      fs.rmSync(path.join(refsDir(p.id), r.file), { force: true });
      p.references = p.references.filter((x) => x.id !== r.id);
      for (const c of p.characters) c.referenceIds = c.referenceIds.filter((id) => id !== r.id);
    }),
  );
});

// ---- Claude breakdown ----
app.post("/api/projects/:id/breakdown", (req, res) => {
  const id = safeId(req.params.id);
  const project = getProject(id);
  const job = startJob("breakdown", id, `Storyboard for "${project.name}"`, async (report) => {
    const { result } = await breakdownScript(getProject(id), report);
    updateProject(id, (p) => applyBreakdown(p, result));
    report(`Done: ${result.characters.length} characters, ${result.scenes.length} scenes.`);
  });
  res.json(job);
});

// ---- characters & scenes ----
const SCENE_FIELDS: (keyof Scene)[] = [
  "title", "durationSec", "location", "characterIds", "action", "shot", "imagePrompt", "videoPrompt", "dialogue", "sound",
];
const CHAR_FIELDS: (keyof Character)[] = ["name", "role", "description", "visualPrompt", "referenceIds"];

app.put("/api/projects/:id/scenes/:sceneId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const s = p.scenes.find((x) => x.id === req.params.sceneId);
      if (!s) return;
      const patch = pick<Scene>(req.body, SCENE_FIELDS);
      if (patch.durationSec !== undefined && !DURATIONS.includes(patch.durationSec)) delete patch.durationSec;
      Object.assign(s, patch);
    }),
  );
});
app.post("/api/projects/:id/scenes", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const after = p.scenes.findIndex((x) => x.id === req.body?.afterId);
      const scene: Scene = {
        id: newId(), number: 0, title: "New scene",
        durationSec: p.settings.seconds === "auto" ? 8 : p.settings.seconds,
        location: "", characterIds: [], action: "", shot: "", imagePrompt: "", videoPrompt: "",
        dialogue: "", sound: "", imageStatus: "idle", videoStatus: "idle",
      };
      p.scenes.splice(after >= 0 ? after + 1 : p.scenes.length, 0, scene);
      p.scenes.forEach((s, i) => (s.number = i + 1));
    }),
  );
});
app.post("/api/projects/:id/scenes/:sceneId/move", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const i = p.scenes.findIndex((x) => x.id === req.params.sceneId);
      const j = i + (req.body?.direction === "up" ? -1 : 1);
      if (i < 0 || j < 0 || j >= p.scenes.length) return;
      [p.scenes[i], p.scenes[j]] = [p.scenes[j], p.scenes[i]];
      p.scenes.forEach((s, k) => (s.number = k + 1));
    }),
  );
});
app.delete("/api/projects/:id/scenes/:sceneId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      p.scenes = p.scenes.filter((x) => x.id !== req.params.sceneId);
      p.scenes.forEach((s, i) => (s.number = i + 1));
    }),
  );
});
app.put("/api/projects/:id/characters/:charId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      const c = p.characters.find((x) => x.id === req.params.charId);
      if (c) Object.assign(c, pick<Character>(req.body, CHAR_FIELDS));
    }),
  );
});
app.post("/api/projects/:id/characters", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      p.characters.push({
        id: newId(), name: String(req.body?.name || "New character"), role: "", description: "",
        visualPrompt: "", referenceIds: [], portraitStatus: "idle",
      });
    }),
  );
});
app.delete("/api/projects/:id/characters/:charId", (req, res) => {
  res.json(
    updateProject(safeId(req.params.id), (p) => {
      p.characters = p.characters.filter((x) => x.id !== req.params.charId);
      for (const s of p.scenes) s.characterIds = s.characterIds.filter((id) => id !== req.params.charId);
    }),
  );
});

// ---- rendering in Flow ----
type RenderKind = "portrait" | "image" | "video";

app.post("/api/projects/:id/render", (req, res) => {
  const id = safeId(req.params.id);
  const kind = req.body?.kind as RenderKind;
  if (!["portrait", "image", "video"].includes(kind)) return void res.status(400).json({ error: "Unknown render kind" });
  const project = getProject(id);
  const ids: string[] | undefined = Array.isArray(req.body?.ids) ? req.body.ids : undefined;
  const targets =
    kind === "portrait"
      ? project.characters.filter((c) => !ids || ids.includes(c.id))
      : project.scenes.filter((s) => !ids || ids.includes(s.id));

  const setStatus = (targetId: string, status: Scene["imageStatus"], extra: Partial<Scene & Character> = {}) =>
    updateProject(id, (p) => {
      if (kind === "portrait") {
        const c = p.characters.find((x) => x.id === targetId);
        if (c) Object.assign(c, { portraitStatus: status, ...extra });
      } else {
        const s = p.scenes.find((x) => x.id === targetId);
        if (s) Object.assign(s, { [kind === "image" ? "imageStatus" : "videoStatus"]: status, ...extra });
      }
    });

  const jobs = targets.map((t) => {
    setStatus(t.id, "queued", { error: undefined });
    const label =
      kind === "portrait" ? `Portrait: ${(t as Character).name}` : `Scene ${(t as Scene).number} ${kind}`;
    return queueFlowJob(
      kind,
      id,
      label,
      async (report) => {
        setStatus(t.id, "running");
        try {
          const p = getProject(id);
          const file =
            kind === "portrait"
              ? await renderPortrait(p, t.id, report)
              : kind === "image"
                ? await renderSceneImage(p, t.id, report)
                : await renderSceneVideo(p, t.id, report);
          const key = kind === "portrait" ? "portraitFile" : kind === "image" ? "imageFile" : "videoFile";
          setStatus(t.id, "done", { [key]: file });
        } catch (e) {
          setStatus(t.id, "failed", { error: (e as Error).message });
          throw e;
        }
      },
      t.id,
      () => setStatus(t.id, "idle"),
    );
  });
  res.json(jobs);
});

// ---- jobs ----
app.get("/api/jobs", (req, res) => res.json(listJobs(req.query.projectId as string | undefined)));
app.post("/api/jobs/:jobId/cancel", (req, res) => res.json(cancelJob(req.params.jobId) ?? null));

// ---- Google Flow connection ----
app.get("/api/flow/status", async (_req, res) => res.json(await flowStatus()));
app.post("/api/flow/connect", async (_req, res) => res.json(await openFlow()));

// ---- files: references and renders ----
app.get("/files/:projectId/:folder/:file", (req, res) => {
  const { folder, file } = req.params;
  if (!["refs", "renders"].includes(folder) || !/^[\w.-]+$/.test(file)) return void res.sendStatus(404);
  res.sendFile(path.join(PROJECTS_DIR, safeId(req.params.projectId), folder, file));
});

// ---- production: serve the built UI ----
const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|files).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
  res.status(missing ? 404 : 400).json({ error: missing ? "Not found" : err.message });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Flow Studio PH API on http://127.0.0.1:${PORT}`);
});
