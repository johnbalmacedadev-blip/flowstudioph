import type { RenderStatus } from "../../../shared/types";

/** A small spinning gear for buttons whose render is queued or running. */
export function Gear() {
  return (
    <svg className="gear" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.3 7.3 0 0 0-1.7-1l-.4-2.7a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.7a7.3 7.3 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.7c0 .2.2.4.5.4h4c.3 0 .5-.2.5-.4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6L19.4 13ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"
      />
    </svg>
  );
}

export const isBusy = (s?: RenderStatus) => s === "queued" || s === "running";

/**
 * A render button's label: the normal label when idle, or a spinning gear with "Queued…" / the running label
 * while that render waits its turn or runs.
 */
export function RenderLabel({ status, idle, running }: { status?: RenderStatus; idle: string; running: string }) {
  if (status === "queued") return <><Gear /> Queued…</>;
  if (status === "running") return <><Gear /> {running}</>;
  return <>{idle}</>;
}
