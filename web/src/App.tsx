import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, FlowStatus, Job, Project, ProjectSummary } from "../../shared/types";
import { api } from "./api";
import { CharactersTab } from "./components/CharactersTab";
import { FinalCutTab } from "./components/FinalCutTab";
import { JobsPanel } from "./components/JobsPanel";
import { ProjectList } from "./components/ProjectList";
import { ScriptTab } from "./components/ScriptTab";
import { SettingsDialog } from "./components/SettingsDialog";
import { StoryboardTab } from "./components/StoryboardTab";

type Tab = "script" | "characters" | "storyboard" | "finalcut";
const TABS: { id: Tab; label: string }[] = [
  { id: "script", label: "1 · Script & references" },
  { id: "characters", label: "2 · Cast & Products" },
  { id: "storyboard", label: "3 · Storyboard" },
  { id: "finalcut", label: "4 · Final Cut" },
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

  // Jobs: poll, and reload the project whenever any of its jobs changes state, or when it was changed
  // from outside the page (e.g. a storyboard loaded by Claude Code).
  const seenUpdate = useRef("");
  useEffect(() => {
    if (!project) return;
    const id = project.id;
    seenUpdate.current = project.updatedAt;
    const tick = async () => {
      const [list, summaries] = await Promise.all([api.jobs(id).catch(() => null), api.projects().catch(() => null)]);
      if (!list) return;
      setJobs(list);
      const snap = list.map((j) => `${j.id}:${j.status}:${j.progress}`).join("|");
      const active = list.some((j) => j.status === "running" || j.status === "queued");
      const updatedAt = summaries?.find((s) => s.id === id)?.updatedAt ?? "";
      const changedElsewhere = updatedAt && updatedAt !== seenUpdate.current;
      if (summaries) setProjects(summaries);
      if (snap !== jobSnapshot.current || active || changedElsewhere) {
        jobSnapshot.current = snap;
        seenUpdate.current = updatedAt;
        api.project(id).then((p) => {
          seenUpdate.current = p.updatedAt;
          setProject((cur) => (cur?.id === id ? p : cur));
        });
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
          {flow?.signedIn && <CreditsPill flow={flow} onRefresh={() => api.refreshCredits().then(setFlow).catch((e) => setError(e.message))} />}
          <FlowPill flow={flow} connecting={connecting} onConnect={connect}
            onToggleWindow={() => flow && api.flowWindow(!flow.windowVisible).then(setFlow).catch((e) => setError(e.message))} />
          <button className="btn ghost" onClick={() => setShowSettings(true)}>Settings</button>
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
            <Welcome onCreate={create} connected={!!flow?.signedIn} />
          ) : (
            <>
              <nav className="tabs">
                {TABS.map((t) => (
                  <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
                    {t.label}
                    {t.id === "characters" && project.characters.length + (project.products?.length ?? 0) > 0 && (
                      <span className="count">{project.characters.length + (project.products?.length ?? 0)}</span>
                    )}
                    {t.id === "storyboard" && project.scenes.length > 0 && <span className="count">{project.scenes.length}</span>}
                    {t.id === "finalcut" && project.scenes.some((s) => s.videoFile) && (
                      <span className="count">{project.scenes.filter((s) => s.videoFile).length}</span>
                    )}
                  </button>
                ))}
              </nav>
              {tab === "script" && (
                <ScriptTab project={project} jobs={jobs} flow={flow} onChange={update} onError={setError}
                  onDone={() => setTab("storyboard")} />
              )}
              {tab === "characters" && <CharactersTab project={project} flow={flow} onChange={update} onError={setError} />}
              {tab === "storyboard" && <StoryboardTab project={project} flow={flow} onChange={update} onError={setError} />}
              {tab === "finalcut" && <FinalCutTab project={project} jobs={jobs} onChange={update} onError={setError} />}
            </>
          )}
        </main>

        {project && <JobsPanel jobs={jobs} active={activeJobs} />}
      </div>

      {showSettings && settings && (
        <SettingsDialog settings={settings} flow={flow} onClose={() => setShowSettings(false)} onSaved={setSettings}
          onSwitchAccount={() => api.switchFlowAccount().then(setFlow)} />
      )}
    </div>
  );
}

/** Google Flow credits left, as Flow last showed them (read after each render); click to read them again. */
function CreditsPill({ flow, onRefresh }: { flow: FlowStatus; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const known = flow.credits !== undefined;
  const when = flow.creditsAt && known ? new Date(flow.creditsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  return (
    <button
      className={`credits-pill ${known && flow.credits! < 100 ? "low" : ""}`}
      disabled={busy}
      onClick={() => { setBusy(true); onRefresh().finally(() => setBusy(false)); }}
      title={`${known ? `Google Flow credits left, as of ${when}. ${flow.creditsResets ? `${flow.creditsResets}. ` : ""}` : ""}Updated after each render. Click to check again (waits for any render to finish).`}
    >
      <span className="credits-icon">✦</span>
      {busy ? "Checking…" : known ? `${flow.credits!.toLocaleString()} credits` : "Credits…"}
    </button>
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

function Welcome({ onCreate, connected }: { onCreate: () => void; connected: boolean }) {
  return (
    <div className="welcome">
      <h1>From script to storyboard to screen.</h1>
      <p>
        Paste a script, a workflow or a long master prompt, add your reference images, and Google Flow's own AI breaks
        it into characters and timed scenes. Then render every frame and clip, and cut the film, all in your own Flow
        account. No API keys, nothing extra to pay.
      </p>
      <ol className="steps">
        <li className={connected ? "done" : ""}>
          Click <b>Connect Google Flow</b> (top right) and sign in once in the Chrome window that opens.
        </li>
        <li>Create a project and paste your script.</li>
        <li>Generate the storyboard, render, then export from Final Cut.</li>
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
