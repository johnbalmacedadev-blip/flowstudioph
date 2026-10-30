import type { Job, JobKind } from "../shared/types.js";
import { newId } from "./store.js";

const jobs: Job[] = [];
let flowChain: Promise<void> = Promise.resolve();

export function listJobs(projectId?: string) {
  return jobs.filter((j) => !projectId || j.projectId === projectId).slice(-200);
}

export function cancelJob(id: string) {
  const job = jobs.find((j) => j.id === id);
  if (job && job.status === "queued") job.status = "cancelled";
  return job;
}

type Runner = (report: (progress: string) => void, job: Job) => Promise<void>;

function makeJob(kind: JobKind, projectId: string, label: string, targetId?: string): Job {
  const job: Job = {
    id: newId(),
    kind,
    projectId,
    targetId,
    label,
    status: "queued",
    progress: "Waiting…",
    createdAt: new Date().toISOString(),
  };
  jobs.push(job);
  return job;
}

async function run(job: Job, runner: Runner) {
  if (job.status === "cancelled") return;
  job.status = "running";
  try {
    await runner((p) => (job.progress = p), job);
    job.status = "done";
    if (job.kind !== "breakdown") job.progress = "Done";
  } catch (e) {
    job.status = "failed";
    job.error = (e as Error).message;
    job.progress = "Failed";
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

/** Claude calls run right away and in parallel. */
export function startJob(kind: JobKind, projectId: string, label: string, runner: Runner, targetId?: string) {
  const job = makeJob(kind, projectId, label, targetId);
  void run(job, runner);
  return job;
}

/**
 * Flow jobs share one Chrome tab, so they run one at a time, with a short human-paced
 * pause between them. onCancel lets the caller reset state for a job that never ran.
 */
export function queueFlowJob(
  kind: JobKind,
  projectId: string,
  label: string,
  runner: Runner,
  targetId?: string,
  onCancel?: () => void,
) {
  const job = makeJob(kind, projectId, label, targetId);
  flowChain = flowChain.then(async () => {
    if (job.status === "cancelled") return onCancel?.();
    await run(job, runner);
    await pause();
  });
  return job;
}

async function pause() {
  if (!jobs.some((j) => j.status === "queued")) return;
  await new Promise((r) => setTimeout(r, 8000 + Math.random() * 12000));
}
