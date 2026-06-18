// Render a sticky's plain-text content as markdown for the READ view. Storage stays plain text — a
// sticky is markdown-by-convention, not a rich-text data model. The MCP path is untouched (Claude
// reads the raw text). This runs only in the human web UI.
//
// SECURITY: sticky text is untrusted input. marked can emit raw HTML and javascript: URLs, so the
// output MUST be sanitized. We parse with GFM (bare URLs autolink) then DOMPurify the HTML, and add
// target/rel to links via a hook so taps open safely in a new tab.

import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true, // GitHub-flavored: autolinks bare URLs, tables, etc.
  breaks: true, // a single newline becomes <br> (matches how people type in a note)
});

// GFM task items (- [ ] / - [x]) render as raw <input type=checkbox> by default — which looks
// broken in a sticky (unstyled boxes, and they wrongly appear interactive). Render them as a styled,
// NON-interactive glyph instead so done (✓) vs to-do (▢) is visually clear and matches the read view.
marked.use({
  renderer: {
    listitem(item: Tokens.ListItem) {
      const body = this.parser.parse(item.tokens);
      if (!item.task) return `<li>${body}</li>`;
      // marked injects a raw <input type=checkbox> at the start of a task item's body — strip it
      // and replace with our own non-interactive glyph (▢ / ✓).
      const stripped = body.replace(/^\s*<input[^>]*>\s*/i, "");
      const cls = item.checked ? "md-task md-task--done" : "md-task";
      const glyph = item.checked ? "✓" : "▢";
      return `<li class="${cls}"><span class="md-check" aria-hidden="true">${glyph}</span>${stripped}</li>`;
    },
  },
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
