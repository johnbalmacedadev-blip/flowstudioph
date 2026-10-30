import { useEffect, useState } from "react";

/** A text field that keeps its own draft and saves when you leave it. */
export function Editable({ value, onSave, multiline, rows = 3, placeholder, className }: {
  value: string;
  onSave: (v: string) => void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onSave(draft);
  return multiline ? (
    <textarea className={className} rows={rows} value={draft} placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
  ) : (
    <input className={className} value={draft} placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  );
}
