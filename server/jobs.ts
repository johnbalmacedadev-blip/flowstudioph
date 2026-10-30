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
    if (job.kind !== "breakdown" && job.kind !== "export") job.progress = "Done";
  } catch (e) {
    job.status = "failed";
    job.error = friendlyError(e as Error);
    job.progress = "Failed";
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

/**
 * Browser-automation errors carry colour codes and a call log; keep one readable sentence.
 * Our own errors are already written for people and pass through unchanged.
 */
export function friendlyError(e: Error): string {
  const first = e.message.replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0].trim();
  if (e.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(first)) {
    return "Google Flow's page didn't respond as expected. Make sure the Flow window is still open and signed in, then try again.";
  }
  if (/Target (page|closed)|browser has been closed|ECONNREFUSED/i.test(first)) {
    return "The Google Flow window was closed. Click Connect Google Flow, then try again.";
  }
  return first.replace(/^(locator|page|browserType)\.\w+: /, "");
}

/** Jobs that don't need the Flow window (Quick split, 720p export) run right away and in parallel. */
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
