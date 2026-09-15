#!/usr/bin/env node
/* Static layout contract for the responsive settings sidebar. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

function parseAttributes(source) {
  const attrs = {};
  const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrPattern.exec(source))) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function parseHtml(source) {
  const root = { tag: '#document', attrs: {}, children: [], parent: null };
  const stack = [root];
  const tagPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>/g;
  let match;
  while ((match = tagPattern.exec(source))) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const close = /^<\/\s*([A-Za-z][\w:-]*)/.exec(token);
      if (!close) continue;
      const closingTag = close[1].toLowerCase();
      const index = stack.map((node) => node.tag).lastIndexOf(closingTag);
      if (index > 0) stack.length = index;
      continue;
    }
    const open = /^<\s*([A-Za-z][\w:-]*)([\s\S]*?)\/?\s*>$/.exec(token);
    if (!open) continue;
    const node = {
      tag: open[1].toLowerCase(),
      attrs: parseAttributes(open[2]),
      children: [],
      parent: stack[stack.length - 1],
    };
    node.parent.children.push(node);
    if (!VOID_TAGS.has(node.tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  return root;
}

function descendants(node, predicate) {
  const result = [];
  const visit = (candidate) => {
    for (const child of candidate.children) {
      if (predicate(child)) result.push(child);
      visit(child);
    }
  };
  visit(node);
  return result;
}

function byId(id) {
  const matches = descendants(documentRoot, (node) => node.attrs.id === id);
  assert.equal(matches.length, 1, `expected exactly one #${id}`);
  return matches[0];
}

function hasClass(node, className) {
  return (node.attrs.class || '').split(/\s+/).includes(className);
}

function contains(ancestor, node) {
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

const documentRoot = parseHtml(html);
const app = byId('app');
const settingsPanel = byId('settingsPanel');
const resultsPanel = byId('resultsPanel');
const options = byId('options');

assert.equal(settingsPanel.tag, 'aside', '#settingsPanel must be an <aside>');
assert.ok(
  settingsPanel.attrs['aria-labelledby'] || settingsPanel.attrs['aria-label'],
  '#settingsPanel needs an accessible name',
);
assert.ok(contains(resultsPanel, options), '#resultsPanel must contain #options');

const editableControls = descendants(documentRoot, (node) => node.tag === 'input' || node.tag === 'select');
const misplacedControls = editableControls.filter((node) => !contains(settingsPanel, node));
assert.equal(
  misplacedControls.length,
  0,
  `all input/select controls must be inside #settingsPanel (outside: ${misplacedControls.map((node) => node.attrs.id || node.tag).join(', ')})`,
);

for (const node of descendants(options, (candidate) => candidate.tag === 'input' || candidate.tag === 'select')) {
  assert.fail(`#options must contain result cards only, found editable ${node.tag}#${node.attrs.id || ''}`);
}

assert.ok(descendants(settingsPanel, (node) => node.attrs.id === 'presets').length, '#presets must be in #settingsPanel');
assert.ok(descendants(settingsPanel, (node) => node.attrs.id === 'advancedPanel').length, '#advancedPanel must be in #settingsPanel');

const scenarioButtonIds = ['scenarioSave', 'scenarioExport', 'scenarioImport', 'scenarioReset'];
const scenarioButtons = scenarioButtonIds.map(byId);
function commonAncestor(nodes) {
  let candidate = nodes[0].parent;
  while (candidate && !nodes.every((node) => contains(candidate, node))) candidate = candidate.parent;
  return candidate;
}

const scenarioToolbar = commonAncestor(scenarioButtons);
assert.ok(
  scenarioToolbar && contains(settingsPanel, scenarioToolbar),
  'scenario controls must share a toolbar inside #settingsPanel',
);

const pageHeads = descendants(documentRoot, (node) => hasClass(node, 'page-head'));
assert.equal(pageHeads.length, 1, 'expected one compact .page-head');
assert.ok(contains(resultsPanel, pageHeads[0]), '.page-head belongs in the results area');

const settingsToggle = byId('settingsToggle');
assert.equal(settingsToggle.tag, 'button', '#settingsToggle must be a button');
assert.equal(settingsToggle.attrs.type, 'button', '#settingsToggle must have type=button');
assert.equal(settingsToggle.attrs['aria-controls'], 'settingsPanel', '#settingsToggle must control #settingsPanel');
assert.ok(['true', 'false'].includes(settingsToggle.attrs['aria-expanded']), '#settingsToggle needs aria-expanded');

for (const id of ['settingsClose', 'settingsBackdrop']) {
  const control = byId(id);
  assert.equal(control.tag, 'button', `#${id} must be a button`);
  assert.equal(control.attrs.type, 'button', `#${id} must have type=button`);
}

assert.ok(['open', 'closed'].includes(app.attrs['data-settings']), '#app data-settings must be open or closed');

const breakdowns = descendants(resultsPanel, (node) => node.tag === 'details' && hasClass(node, 'cost-breakdown'));
assert.equal(breakdowns.length, 4, 'each result card has an expandable breakdown');
assert.ok(breakdowns.every((node) => !('open' in node.attrs)), 'cost breakdowns are collapsed initially');

const drawerCode = html.split('// ─── Settings drawer ───')[1].split('// ─── Scenario helpers ───')[0];
const focusDoc = { activeElement: null };
const closedSection = {};
const focusNode = (tagName, closed = null) => ({
  tagName, parentElement: closed, disabled: false, hidden: false,
  closest: () => closed, getClientRects: () => [{}],
  focus() { focusDoc.activeElement = this; },
});
const closeButton = focusNode('BUTTON');
const lastSummary = focusNode('SUMMARY', closedSection);
const hiddenReset = focusNode('BUTTON', closedSection);
focusDoc.activeElement = closeButton;
const drawerContext = vm.createContext({
  App: { settingsOpen: true }, dialogEl: { open: false }, document: focusDoc,
  settingsPanel: { querySelectorAll: () => [closeButton, lastSummary, hiddenReset], contains: () => true },
});
vm.runInContext(drawerCode, drawerContext);
vm.runInContext("onSettingsKeydown({ key: 'Tab', shiftKey: true, preventDefault() {} })", drawerContext);
assert.equal(focusDoc.activeElement, lastSummary, 'backward Tab excludes controls inside closed details even when they have layout rectangles');
vm.runInContext("onSettingsKeydown({ key: 'Tab', shiftKey: false, preventDefault() {} })", drawerContext);
assert.equal(focusDoc.activeElement, closeButton, 'forward Tab wraps to the drawer close button');

console.log('Sidebar layout and keyboard contracts passed');
