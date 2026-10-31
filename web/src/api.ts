import type {
  AppSettings, Character, ExportResolution, FinalCut, FlowStatus, Job, Product, Project, ProjectSettings, ProjectSummary,
  ReferenceKind, Scene,
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
  saveSettings: (s: { maxCreditsPerClip?: number; exportDir?: string }) =>
    call<AppSettings>("PUT", "/api/settings", s),
  /** Windows' folder picker for the export folder; null if you cancel. */
  pickExportDir: () => call<{ dir: string | null }>("POST", "/api/settings/pick-export-dir"),
  openExportDir: () => call<{ ok: boolean }>("POST", "/api/settings/open-export-dir"),
  /** Show an exported file selected in Windows Explorer. */
  revealExport: (id: string, file: string) => call<{ ok: boolean }>("POST", `${P(id)}/exports/${encodeURIComponent(file)}/reveal`),

  projects: () => call<ProjectSummary[]>("GET", "/api/projects"),
  createProject: (name: string) => call<Project>("POST", "/api/projects", { name }),
  project: (id: string) => call<Project>("GET", P(id)),
  updateProject: (id: string, patch: Partial<Omit<Project, "settings">> & { settings?: Partial<ProjectSettings> }) =>
    call<Project>("PUT", P(id), patch),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", P(id)),

  uploadRefs: (id: string, files: File[], kind: ReferenceKind, label?: string, productId?: string) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("kind", kind);
    if (label) fd.append("label", label);
    if (productId) fd.append("productId", productId);
    return call<Project>("POST", `${P(id)}/references`, fd);
  },
  updateRef: (id: string, refId: string, patch: { label?: string; kind?: ReferenceKind }) =>
    call<Project>("PUT", `${P(id)}/references/${refId}`, patch),
  deleteRef: (id: string, refId: string) => call<Project>("DELETE", `${P(id)}/references/${refId}`),

  breakdown: (id: string) => call<Job>("POST", `${P(id)}/breakdown`),
  importStoryboard: (id: string, json: string) => call<Project>("POST", `${P(id)}/storyboard`, { json }),

  updateScene: (id: string, sceneId: string, patch: Partial<Scene>) => call<Project>("PUT", `${P(id)}/scenes/${sceneId}`, patch),
  /** Your own image picks for a scene, or null to let the app choose again. */
  setSceneRefs: (id: string, sceneId: string, keys: string[] | null) =>
    call<Project>("PUT", `${P(id)}/scenes/${sceneId}`, { refOverride: keys }),
  /** Images used exactly: [start] or [start, end]; [] to generate frames again. */
  setSceneExact: (id: string, sceneId: string, keys: string[]) =>
    call<Project>("PUT", `${P(id)}/scenes/${sceneId}`, { exactFrameKeys: keys }),
  /** Images taken off a scene's list (they stay in the project). */
  setSceneHidden: (id: string, sceneId: string, keys: string[]) =>
    call<Project>("PUT", `${P(id)}/scenes/${sceneId}`, { hiddenRefKeys: keys }),
  /** Images added to a scene's pinned start image. */
  setScenePinRefs: (id: string, sceneId: string, keys: string[]) =>
    call<Project>("PUT", `${P(id)}/scenes/${sceneId}`, { pinRefKeys: keys }),
  addScene: (id: string, afterId?: string) => call<Project>("POST", `${P(id)}/scenes`, { afterId }),
  moveScene: (id: string, sceneId: string, direction: "up" | "down") =>
    call<Project>("POST", `${P(id)}/scenes/${sceneId}/move`, { direction }),
  deleteScene: (id: string, sceneId: string) => call<Project>("DELETE", `${P(id)}/scenes/${sceneId}`),

  updateCharacter: (id: string, charId: string, patch: Partial<Character>) =>
    call<Project>("PUT", `${P(id)}/characters/${charId}`, patch),
  addCharacter: (id: string) => call<Project>("POST", `${P(id)}/characters`, {}),
  deleteCharacter: (id: string, charId: string) => call<Project>("DELETE", `${P(id)}/characters/${charId}`),

  addProduct: (id: string) => call<Project>("POST", `${P(id)}/products`, {}),
  updateProduct: (id: string, productId: string, patch: Partial<Product>) =>
    call<Project>("PUT", `${P(id)}/products/${productId}`, patch),
  deleteProduct: (id: string, productId: string) => call<Project>("DELETE", `${P(id)}/products/${productId}`),

  render: (id: string, kind: "portrait" | "product" | "image" | "video", ids?: string[]) =>
    call<Job[]>("POST", `${P(id)}/render`, { kind, ids }),

  finalCut: (id: string) => call<FinalCut>("GET", `${P(id)}/final-cut`),
  saveFinalCut: (id: string, cut: FinalCut) => call<FinalCut>("PUT", `${P(id)}/final-cut`, cut),
  resetFinalCut: (id: string) => call<FinalCut>("POST", `${P(id)}/final-cut/reset`),
  exportCut: (id: string, resolution: ExportResolution) => call<Job>("POST", `${P(id)}/export`, { resolution }),
  deleteExport: (id: string, file: string) => call<Project>("DELETE", `${P(id)}/exports/${file}`),

  jobs: (projectId?: string) => call<Job[]>("GET", `/api/jobs${projectId ? `?projectId=${projectId}` : ""}`),
  cancelJob: (jobId: string) => call<Job | null>("POST", `/api/jobs/${jobId}/cancel`),

  flowStatus: () => call<FlowStatus>("GET", "/api/flow/status"),
  /** Open Google's account chooser in the Flow window to use another account (waits until Flow is free). */
  switchFlowAccount: () => call<FlowStatus>("POST", "/api/flow/account"),
  /** Read the remaining credits from Flow again (waits until Flow is free). */
  refreshCredits: () => call<FlowStatus>("POST", "/api/flow/credits"),
  connectFlow: () => call<FlowStatus>("POST", "/api/flow/connect"),
  flowWindow: (visible: boolean) => call<FlowStatus>("POST", "/api/flow/window", { visible }),
};

export const fileUrl = (projectId: string, folder: "refs" | "renders" | "exports", file: string) =>
  `/files/${projectId}/${folder}/${file}`;
