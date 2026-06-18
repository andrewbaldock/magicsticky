import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderMarkdown } from "./markdown.ts";

// A nicer-than-textarea sticky surface: shows RENDERED markdown by default (links tappable), tap to
// edit (raw textarea takes over, focused), blur back to the rendered view. Storage stays plain text
// — `value` is the raw markdown string, `onChange` gets raw text. The MCP/whoami path never sees
// this; it reads the raw `value`.
//
// An empty sticky, or one being edited, shows the textarea so there's always somewhere to type.
export function StickyEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(value.trim() === "");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // When entering edit mode, focus the textarea and drop the caret at the end.
  useLayoutEffect(() => {
    if (editing && taRef.current) {
      const ta = taRef.current;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [editing]);

  // If the value is emptied out from under us (e.g. undo), make sure there's an editable surface.
  useEffect(() => {
    if (value.trim() === "") setEditing(true);
  }, [value]);

  if (editing) {
    return (
      <textarea
        ref={taRef}
        className="editor"
        value={value}
        placeholder={placeholder}
        spellCheck
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (value.trim() !== "") setEditing(false);
        }}
      />
    );
  }

  // Read view: rendered markdown. Tap anywhere (or focus via keyboard) to edit.
  return (
    <div
      className="editor reader"
      role="textbox"
      tabIndex={0}
      aria-label="Sticky content — tap to edit"
      // Tapping a link should follow the link, not drop into edit mode. Only enter edit on taps
      // that aren't on an anchor.
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a")) setEditing(true);
      }}
      onFocus={() => setEditing(true)}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
    />
  );
}
