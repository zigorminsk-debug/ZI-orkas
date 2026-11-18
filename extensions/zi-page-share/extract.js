'use strict';
// Self-contained because Chrome serializes this function into the selected tab.
function extractPage() {
  const limit = 50000;
  const chunks = [];
  let size = 0, visited = 0, truncated = false;
  const forbidden = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON']);
  const root = document.body;
  if (!root) throw new Error('На странице нет доступного текста');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (++visited > 20000) { truncated = true; break; }
    let el = node.parentElement;
    let hidden = !el;
    let reachedRoot = false;
    for (let depth = 0; el && depth < 100; depth++, el = el.parentElement) {
      if (forbidden.has(el.tagName) || el.isContentEditable || el.hidden || el.getAttribute('aria-hidden') === 'true') { hidden = true; break; }
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') { hidden = true; break; }
      if (el === root) { reachedRoot = true; break; }
    }
    if (hidden || !reachedRoot) continue;
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const remaining = limit - size;
    if (text.length + 1 > remaining) { chunks.push(text.slice(0, Math.max(0, remaining))); truncated = true; break; }
    chunks.push(text); size += text.length + 1;
  }
  const url = new URL(location.href);
  url.search = ''; url.hash = ''; url.username = ''; url.password = '';
  return { title: document.title.slice(0, 500), url: url.toString().slice(0, 2000), text: chunks.join('\n'), truncated };
}
if (typeof module !== 'undefined') module.exports = { extractPage };
