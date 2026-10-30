import type { FlowStatus, Project } from "../../../shared/types";
import { api, fileUrl } from "../api";
import { Editable } from "./Editable";
import { StatusBadge } from "./StatusBadge";

interface Props {
  project: Project;
  flow: FlowStatus | null;
  onChange: (p: Project) => void;
  onError: (msg: string) => void;
}

export function CharactersTab({ project, flow, onChange, onError }: Props) {
  const id = project.id;
  const run = (p: Promise<Project>) => p.then(onChange).catch((e) => onError(e.message));
  const render = (ids?: string[]) => {
    if (!flow?.signedIn) return onError("Connect Google Flow first (top right).");
    api.render(id, "portrait", ids).catch((e) => onError(e.message));
  };
  const charRefs = project.references.filter((r) => r.kind === "character");

  return (
    <div className="tab-body">
      <div className="toolbar">
        <p className="muted">
          Each character's visual description is repeated in every scene prompt so they look the same in every shot.
          Render a portrait in Flow to check the look before you render scenes.
        </p>
        <div className="row tight">
          <button className="btn ghost" onClick={() => run(api.addCharacter(id))}>+ Add character</button>
          <button className="btn primary" disabled={!project.characters.length} onClick={() => render()}>Render all portraits</button>
        </div>
      </div>

      {project.characters.length === 0 && (
        <div className="empty">No characters yet. Generate a storyboard from your script, or add one by hand.</div>
      )}

      <div className="char-grid">
        {project.characters.map((c) => {
          const linked = project.references.filter((r) => c.referenceIds.includes(r.id));
          const cover = c.portraitFile
            ? fileUrl(id, "renders", c.portraitFile)
            : linked[0] && fileUrl(id, "refs", linked[0].file);
          return (
            <div key={c.id} className="card char">
              <div className="char-portrait">
                {cover ? <img src={cover} alt={c.name} /> : <div className="placeholder">{c.name.slice(0, 1)}</div>}
                <StatusBadge status={c.portraitStatus} />
              </div>
              <div className="char-body">
                <Editable className="title-input" value={c.name} onSave={(name) => run(api.updateCharacter(id, c.id, { name }))} />
                <Editable value={c.role} placeholder="Role in the story" onSave={(role) => run(api.updateCharacter(id, c.id, { role }))} />
                <label className="field">
                  <span>Look (used in every prompt)</span>
                  <Editable multiline rows={4} value={c.visualPrompt}
                    onSave={(visualPrompt) => run(api.updateCharacter(id, c.id, { visualPrompt }))} />
                </label>
                {charRefs.length > 0 && (
                  <div className="chips">
                    {charRefs.map((r) => {
                      const on = c.referenceIds.includes(r.id);
                      return (
                        <button key={r.id} className={`chip ${on ? "on" : ""}`}
                          onClick={() => run(api.updateCharacter(id, c.id, {
                            referenceIds: on ? c.referenceIds.filter((x) => x !== r.id) : [...c.referenceIds, r.id],
                          }))}>
                          <img src={fileUrl(id, "refs", r.file)} alt="" /> {r.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {c.error && <div className="error-text small">{c.error}</div>}
                <div className="row tight">
                  <button className="btn small" onClick={() => render([c.id])}>Render portrait</button>
                  <span className="grow" />
                  <button className="btn small ghost danger" onClick={() => confirm(`Remove ${c.name}?`) && run(api.deleteCharacter(id, c.id))}>
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
