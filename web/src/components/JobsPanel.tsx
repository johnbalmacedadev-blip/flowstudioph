import type { Job } from "../../../shared/types";
import { api } from "../api";

export function JobsPanel({ jobs, active }: { jobs: Job[]; active: number }) {
  const list = [...jobs].reverse();
  return (
    <aside className="jobs">
      <div className="sidebar-label">
        Activity {active > 0 && <span className="count live">{active} running</span>}
      </div>
      {list.length === 0 && <p className="muted small">Nothing yet. Storyboard and render jobs show up here.</p>}
      <ul>
        {list.map((j) => (
          <li key={j.id} className={`job ${j.status}`}>
            <div className="job-head">
              <span className="job-label">{j.label}</span>
              <span className={`badge ${j.status}`}>{j.status}</span>
            </div>
            <div className="small muted">{j.error ?? j.progress}</div>
            {j.status === "queued" && (
              <button className="link small" onClick={() => api.cancelJob(j.id)}>Cancel</button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
