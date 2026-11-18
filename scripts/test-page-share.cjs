'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractPage } = require('../extensions/zi-page-share/extract.js');
const manifest = require('../extensions/zi-page-share/manifest.json');

test('extension requests only explicit active-tab access, without network hosts', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'clipboardWrite']);
  assert.equal(manifest.host_permissions, undefined);
  for (const file of ['popup.html', 'popup.js', 'extract.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../extensions/zi-page-share', file), 'utf8'), /\bfetch\s*\(|XMLHttpRequest|sendBeacon/);
  }
});

test('captures visible text only, omits form/hidden values and strips URL credentials and query', () => {
  const globals = { document: global.document, NodeFilter: global.NodeFilter, location: global.location, getComputedStyle: global.getComputedStyle };
  const element = (tagName, parentElement = null, opts = {}) => ({ tagName, parentElement, isContentEditable: !!opts.editable, hidden: !!opts.hidden, getAttribute: name => name === 'aria-hidden' && opts.aria ? 'true' : null, style: opts.style || {} });
  const root = element('BODY');
  const span = element('SPAN', root);
  const hidden = element('DIV', root, { style: { display: 'none' } });
  const entries = [
    { parentElement: span, nodeValue: 'Visible text' },
    { parentElement: element('TEXTAREA', root), nodeValue: 'secret text' },
    { parentElement: element('SPAN', hidden), nodeValue: 'hidden text' },
    { parentElement: element('DIV', root, { editable: true }), nodeValue: 'editable text' },
    { parentElement: element('DIV', root, { aria: true }), nodeValue: 'aria hidden text' },
  ];
  try {
    global.NodeFilter = { SHOW_TEXT: 4 };
    global.location = { href: 'https://user:pass@example.com/page?token=secret#fragment' };
    global.getComputedStyle = el => ({ display: el.style.display || 'block', visibility: 'visible' });
    global.document = { body: root, title: 'Test', createTreeWalker: () => { let i = 0; return { nextNode: () => entries[i++] || null }; } };
    const result = extractPage();
    assert.equal(result.text, 'Visible text');
    assert.equal(result.url, 'https://example.com/page');
    assert.equal(result.truncated, false);
  } finally { Object.assign(global, globals); }
});
