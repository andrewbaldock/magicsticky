// Render a sticky's plain-text content as markdown for the READ view. Storage stays plain text — a
// sticky is markdown-by-convention, not a rich-text data model. The MCP path is untouched (Claude
// reads the raw text). This runs only in the human web UI.
//
// SECURITY: sticky text is untrusted input. marked can emit raw HTML and javascript: URLs, so the
// output MUST be sanitized. We parse with GFM (bare URLs autolink) then DOMPurify the HTML, and add
// target/rel to links via a hook so taps open safely in a new tab.

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true, // GitHub-flavored: autolinks bare URLs, tables, etc.
  breaks: true, // a single newline becomes <br> (matches how people type in a note)
});

// Make every rendered link open in a new tab without leaking the opener. NOTE: this hook is global
// to DOMPurify — fine while this is the only sanitize call in the app; if another caller is added,
// it will also get target/rel forced on its links.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  // Allow only safe protocols (no javascript:/data: links); DOMPurify strips the rest.
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  });
}
