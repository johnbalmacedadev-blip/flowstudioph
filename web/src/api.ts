import type {
  AppSettings, Character, FlowStatus, Job, Project, ProjectSettings, ProjectSummary, ReferenceKind, Scene,
} from "../../shared/types";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const P = (id: string) => `/api/projects/${id}`;

export const api = {
  settings: () => call<AppSettings>("GET", "/api/settings"),
  saveSettings: (s: { apiKey?: string; model?: string; effort?: string; maxCreditsPerClip?: number }) =>
    call<AppSettings>("PUT", "/api/settings", s),

  projects: () => call<ProjectSummary[]>("GET", "/api/projects"),
  createProject: (name: string) => call<Project>("POST", "/api/projects", { name }),
  project: (id: string) => call<Project>("GET", P(id)),
  updateProject: (id: string, patch: Partial<Omit<Project, "settings">> & { settings?: Partial<ProjectSettings> }) =>
    call<Project>("PUT", P(id), patch),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", P(id)),

  uploadRefs: (id: string, files: File[], kind: ReferenceKind, label?: string) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("kind", kind);
    if (label) fd.append("label", label);
    return call<Project>("POST", `${P(id)}/references`, fd);
  },
  updateRef: (id: string, refId: string, patch: { label?: string; kind?: ReferenceKind }) =>
    call<Project>("PUT", `${P(id)}/references/${refId}`, patch),
  deleteRef: (id: string, refId: string) => call<Project>("DELETE", `${P(id)}/references/${refId}`),

  breakdown: (id: string) => call<Job>("POST", `${P(id)}/breakdown`),

  updateScene: (id: string, sceneId: string, patch: Partial<Scene>) => call<Project>("PUT", `${P(id)}/scenes/${sceneId}`, patch),
  addScene: (id: string, afterId?: string) => call<Project>("POST", `${P(id)}/scenes`, { afterId }),
  moveScene: (id: string, sceneId: string, direction: "up" | "down") =>
    call<Project>("POST", `${P(id)}/scenes/${sceneId}/move`, { direction }),
  deleteScene: (id: string, sceneId: string) => call<Project>("DELETE", `${P(id)}/scenes/${sceneId}`),

  updateCharacter: (id: string, charId: string, patch: Partial<Character>) =>
    call<Project>("PUT", `${P(id)}/characters/${charId}`, patch),
  addCharacter: (id: string) => call<Project>("POST", `${P(id)}/characters`, {}),
  deleteCharacter: (id: string, charId: string) => call<Project>("DELETE", `${P(id)}/characters/${charId}`),

  render: (id: string, kind: "portrait" | "image" | "video", ids?: string[]) =>
    call<Job[]>("POST", `${P(id)}/render`, { kind, ids }),

  jobs: (projectId?: string) => call<Job[]>("GET", `/api/jobs${projectId ? `?projectId=${projectId}` : ""}`),
  cancelJob: (jobId: string) => call<Job | null>("POST", `/api/jobs/${jobId}/cancel`),

  flowStatus: () => call<FlowStatus>("GET", "/api/flow/status"),
  connectFlow: () => call<FlowStatus>("POST", "/api/flow/connect"),
  flowWindow: (visible: boolean) => call<FlowStatus>("POST", "/api/flow/window", { visible }),
};

export const fileUrl = (projectId: string, folder: "refs" | "renders", file: string) =>
  `/files/${projectId}/${folder}/${file}`;
