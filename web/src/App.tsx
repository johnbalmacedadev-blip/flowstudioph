import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, FlowStatus, Job, Project, ProjectSummary } from "../../shared/types";
import { api } from "./api";
import { CharactersTab } from "./components/CharactersTab";
import { JobsPanel } from "./components/JobsPanel";
import { ProjectList } from "./components/ProjectList";
import { ScriptTab } from "./components/ScriptTab";
import { SettingsDialog } from "./components/SettingsDialog";
import { StoryboardTab } from "./components/StoryboardTab";

type Tab = "script" | "characters" | "storyboard";
const TABS: { id: Tab; label: string }[] = [
  { id: "script", label: "1 · Script & references" },
  { id: "characters", label: "2 · Characters" },
  { id: "storyboard", label: "3 · Storyboard" },
];

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>("script");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [flow, setFlow] = useState<FlowStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const jobSnapshot = useRef("");

  const refreshProjects = useCallback(() => api.projects().then(setProjects).catch((e) => setError(e.message)), []);

  useEffect(() => {
    refreshProjects();
    api.settings().then(setSettings);
    const lastId = localStorageGet("fsph.project");
    if (lastId) open(lastId);
  }, [refreshProjects]);

  // Flow connection status
  useEffect(() => {
    const tick = () => api.flowStatus().then(setFlow).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);

  // Jobs: poll, and reload the project whenever any of its jobs changes state.
  useEffect(() => {
    if (!project) return;
    const id = project.id;
    const tick = async () => {
      const list = await api.jobs(id).catch(() => null);
      if (!list) return;
      setJobs(list);
      const snap = list.map((j) => `${j.id}:${j.status}:${j.progress}`).join("|");
      const active = list.some((j) => j.status === "running" || j.status === "queued");
      if (snap !== jobSnapshot.current || active) {
        jobSnapshot.current = snap;
        api.project(id).then((p) => setProject((cur) => (cur?.id === id ? p : cur)));
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [project?.id]);

  function open(id: string) {
    api.project(id)
      .then((p) => {
        setProject(p);
        localStorageSet("fsph.project", id);
        setTab(p.scenes.length ? "storyboard" : "script");
      })
      .catch(() => {});
  }

  const create = async () => {
    const p = await api.createProject("Untitled story");
    setProject(p);
    setTab("script");
    localStorageSet("fsph.project", p.id);
    refreshProjects();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this project, its references and renders from this computer?")) return;
    await api.deleteProject(id);
    if (project?.id === id) setProject(null);
    refreshProjects();
  };

  const update = (p: Project) => {
    setProject(p);
    refreshProjects();
  };

  const connect = async () => {
    setConnecting(true);
    try {
      setFlow(await api.connectFlow());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "queued").length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▶</span>
          <span>Flow Studio <b>PH</b></span>
        </div>
        <div className="topbar-right">
          <FlowPill flow={flow} connecting={connecting} onConnect={connect}
            onToggleWindow={() => flow && api.flowWindow(!flow.windowVisible).then(setFlow).catch((e) => setError(e.message))} />
          <button className={`btn ghost ${settings && !settings.hasApiKey ? "attention" : ""}`} onClick={() => setShowSettings(true)}>
            {settings?.hasApiKey ? "Settings" : "Add Claude API key"}
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error" onClick={() => setError("")}>
          {error} <span className="muted">(click to dismiss)</span>
        </div>
      )}

      <div className="layout">
        <ProjectList projects={projects} currentId={project?.id} onOpen={open} onCreate={create} onDelete={remove} />

        <main className="main">
          {!project ? (
            <Welcome onCreate={create} hasKey={!!settings?.hasApiKey} onSettings={() => setShowSettings(true)} />
          ) : (
            <>
              <nav className="tabs">
                {TABS.map((t) => (
                  <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
                    {t.label}
                    {t.id === "characters" && project.characters.length > 0 && <span className="count">{project.characters.length}</span>}
                    {t.id === "storyboard" && project.scenes.length > 0 && <span className="count">{project.scenes.length}</span>}
                  </button>
                ))}
              </nav>
              {tab === "script" && (
                <ScriptTab project={project} jobs={jobs} settings={settings} onChange={update} onError={setError}
                  onDone={() => setTab("storyboard")} />
              )}
              {tab === "characters" && <CharactersTab project={project} flow={flow} onChange={update} onError={setError} />}
              {tab === "storyboard" && <StoryboardTab project={project} flow={flow} onChange={update} onError={setError} />}
            </>
          )}
        </main>

        {project && <JobsPanel jobs={jobs} active={activeJobs} />}
      </div>

      {showSettings && settings && (
        <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} onSaved={setSettings} />
      )}
    </div>
  );
}

function FlowPill({ flow, connecting, onConnect, onToggleWindow }: {
  flow: FlowStatus | null;
  connecting: boolean;
  onConnect: () => void;
  onToggleWindow: () => void;
}) {
  const state = !flow?.browserOpen ? "off" : flow.signedIn ? "on" : "wait";
  const label =
    state === "on" ? "Google Flow connected" : state === "wait" ? flow?.message ?? "Connecting…" : "Google Flow offline";
  return (
    <div className={`flow-pill ${state}`} title={flow?.message}>
      <span className="dot" />
      <span className="flow-label">{label}</span>
      {state === "off" ? (
        <button className="btn small" onClick={onConnect} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect Google Flow"}
        </button>
      ) : (
        <button className="btn small ghost" onClick={onToggleWindow}
          title="Flow runs in a hidden Chrome window. Show it to watch, or to fix something by hand.">
          {flow?.windowVisible ? "Hide Flow" : "Show Flow"}
        </button>
      )}
    </div>
  );
}

function Welcome({ onCreate, hasKey, onSettings }: { onCreate: () => void; hasKey: boolean; onSettings: () => void }) {
  return (
    <div className="welcome">
      <h1>From script to storyboard to screen.</h1>
      <p>
        Paste a script, a workflow or a long master prompt, add your reference images, and Claude breaks it into
        characters and timed scenes. Then render every frame and clip in your own Google Flow account.
      </p>
      <ol className="steps">
        <li className={hasKey ? "done" : ""}>
          Add your Claude API key {!hasKey && <button className="link" onClick={onSettings}>Open settings</button>}
        </li>
        <li>Click <b>Connect Google Flow</b> (top right) and sign in once in the Chrome window that opens.</li>
        <li>Create a project and paste your script.</li>
      </ol>
      <button className="btn primary big" onClick={onCreate}>+ New project</button>
    </div>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: just don't remember */
  }
}
