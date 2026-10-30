import type { RenderStatus } from "../../../shared/types";

const LABEL: Record<RenderStatus, string> = {
  idle: "",
  queued: "Queued",
  running: "Rendering…",
  done: "Ready",
  failed: "Failed",
};

export function StatusBadge({ status }: { status: RenderStatus }) {
  if (status === "idle") return null;
  return <span className={`badge overlay ${status}`}>{LABEL[status]}</span>;
}
