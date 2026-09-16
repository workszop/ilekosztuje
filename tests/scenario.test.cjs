const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const js = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const section = js.split('// ─── Scenario helpers ───')[1]?.split('// ─── Listeners ───')[0];
assert.ok(section, 'Scenario serialization and validation helpers must exist');
const constants = js.slice(0, js.indexOf('// ─── State'));
const core = js.slice(js.indexOf('// CSV parser'), js.indexOf('// ─── Render'));
const csv = html.match(/<script id="csvData"[^>]*>([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({ console, csv });
vm.runInContext(constants + core + section, context);
vm.runInContext(`
  const original = { ...DEFAULTS, lang: 'en', models: modelsFromCsv(csv), csvText: csv, csvSource: null };
  const saved = serializeScenario(original);
  const loaded = parseScenario(JSON.stringify(saved));
  if (loaded.values.users !== DEFAULTS.users || loaded.models.length !== 10 || loaded.values.lang !== 'en' || loaded.values.maxUtilization !== DEFAULTS.maxUtilization) throw Error('round trip');
  const customized = { ...original, maxUtilization: 67 };
  const customizedSaved = serializeScenario(customized);
  if (customizedSaved.values.maxUtilization !== 67 || parseScenario(JSON.stringify(customizedSaved)).values.maxUtilization !== 67) throw Error('max utilization round trip');
  function mustReject(value) { let rejected = false; try { parseScenario(JSON.stringify(value)); } catch (_) { rejected = true; } if (!rejected) throw Error('accepted invalid scenario'); }
  const legacyScenario = { ...saved, values: { ...saved.values } }; delete legacyScenario.values.smallRecommendFrom;
  if (parseScenario(JSON.stringify(legacyScenario)).values.smallRecommendFrom !== DEFAULTS.smallRecommendFrom) throw Error('smallRecommendFrom backfill');
  mustReject({ ...saved, version: 999 });
  mustReject({ ...saved, values: { ...saved.values, ownAmort: 0 } });
  mustReject({ ...saved, values: { ...saved.values, users: '20' } });
  mustReject({ ...saved, values: { ...saved.values, users: 1e100 } });
  mustReject({ ...saved, values: { ...saved.values, cloudMode: 'invalid' } });
  mustReject({ ...saved, values: { ...saved.values, lang: 'xx' } });
  mustReject({ ...saved, values: { ...saved.values, model: 'missing model' } });
  mustReject({ ...saved, values: { ...saved.values, maxUtilization: null } });
  mustReject({ ...saved, values: { ...saved.values, maxUtilization: '80' } });
  mustReject({ ...saved, values: { ...saved.values, maxUtilization: 0 } });
  mustReject({ ...saved, values: { ...saved.values, maxUtilization: 101 } });
  mustReject({ ...saved, values: { ...saved.values, maxUtilization: 80.5 } });
  mustReject({ ...saved, csvText: 'invalid' });
  const legacy = { ...saved, values: { ...saved.values } };
  delete legacy.values.maxUtilization;
  const legacyLoaded = parseScenario(JSON.stringify(legacy));
  if (legacyLoaded.values.maxUtilization !== DEFAULTS.maxUtilization) throw Error('legacy v1 default migration');
  const legacyMissingOther = { ...legacy, values: { ...legacy.values } };
  delete legacyMissingOther.values.users;
  mustReject(legacyMissingOther);
  if ('models' in saved.values || 'csvText' in saved.values) throw Error('unexpected serialized state');
  const state = original;
  const before = JSON.stringify(original);
  const missingDom = { querySelector: () => null, querySelectorAll: () => [] };
  const badChecks = checkDomContract(missingDom, null);
  if (badChecks.length < 5 || badChecks.some((c) => c.pass) || JSON.stringify(original) !== before) throw Error('missing DOM contract must fail without mutation');
  const App = { invalidFields: new Set() }, appEl = { dataset: {} };
  const status = {};
  function $(id) { return status; }
  function t(key) { return key; }
  function applyI18n() {}
  function renderModelSelect() {}
  function syncInputs() {}
  function render() {}
  state.lang = 'pl';
  applyScenario(loaded);
  if (state.lang !== 'pl') throw Error('import must preserve current language preference');
  console.log('Scenario round trip and malformed-input checks passed');
`, context);
