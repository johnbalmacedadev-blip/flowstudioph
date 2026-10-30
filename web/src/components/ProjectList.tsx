import type { ProjectSummary } from "../../../shared/types";

interface Props {
  projects: ProjectSummary[];
  currentId?: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

export function ProjectList({ projects, currentId, onOpen, onCreate, onDelete }: Props) {
  return (
    <aside className="sidebar">
      <button className="btn primary block" onClick={onCreate}>+ New project</button>
      <div className="sidebar-label">Projects</div>
      {projects.length === 0 && <p className="muted small">No projects yet.</p>}
      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id} className={p.id === currentId ? "active" : ""} onClick={() => onOpen(p.id)}>
            <div className="project-name">{p.name}</div>
            <div className="muted small">
              {p.sceneCount} scenes · {p.characterCount} characters
            </div>
            <button
              className="icon-btn"
              title="Delete project"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(p.id);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
