/**
 * markdown-entry.js — Markdown renderer bundle entry point
 *
 * Bundles `marked` (CommonMark / GFM parser) + `DOMPurify` (HTML sanitizer)
 * into a single renderer for the in-app user guide (docs-viewer.js).
 *
 * marked turns markdown into HTML; DOMPurify then strips any scripts, inline
 * event handlers and javascript: URLs that survive parsing, so the output is
 * safe to assign via innerHTML in the sandboxed docs window.
 *
 * Every link is forced to target="_blank" so the main process opens it in the
 * system browser (see setWindowOpenHandler in main.js) instead of navigating
 * the app window.
 *
 * This file is NOT imported at runtime — it is compiled by esbuild into
 *   web/scripts/vendor/markdown.js
 * via the `vendor-markdown` npm / make target.
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

// Open every link in the system browser; never navigate the docs window.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Render a markdown source string to sanitized HTML. */
export function renderMarkdown(src) {
  const rawHtml = marked.parse(src ?? "", { async: false });
  return DOMPurify.sanitize(rawHtml);
}

export default renderMarkdown;
