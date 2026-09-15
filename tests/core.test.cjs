const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const htmlPath = path.join(__dirname, '../index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const js = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const constants = js.slice(0, js.indexOf('// ─── State'));
const core = js.slice(js.indexOf('// CSV parser'), js.indexOf('// ─── Render'));
const csv = html.match(/<script id="csvData"[^>]*>([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({ console });
vm.runInContext(constants + core, context);

const run = (source) => vm.runInContext(source, context);
const models = run(`modelsFromCsv(${JSON.stringify(csv)})`);
context.models = models;
const defaults = run('({ ...DEFAULTS, lang: "en", models: [] })');

assert.equal(models.length, 10, 'built-in CSV has ten models');
assert.equal(new Set(models.map((m) => m.id)).size, models.length, 'model IDs are unique');
assert.equal(new Set(models.map((m) => m.name)).size, models.length, 'model names are unique');
assert.equal(models.find((m) => m.id === 'claude-fable-5-1').alwaysThinks, true, 'Fable is always reasoning');
assert.equal(models.find((m) => m.id === 'claude-haiku-4-5-20251001').maxOutput, 64000, 'Haiku output limit');
assert.equal(models.find((m) => m.id === 'deepseek-flash').maxOutput, 384000, 'DeepSeek output limit');
assert.equal(models.find((m) => m.id === 'gpt-6-astra').maxOutput, 128000, 'Astra output limit');
assert.equal(models.find((m) => m.id === 'gpt-6-astra').alwaysThinks, true, 'Astra always uses reasoning');

assert.deepEqual(JSON.parse(JSON.stringify(run('validateState(DEFAULTS)'))), {}, 'defaults validate');
assert.equal(run('validateField("users", 0).error'), 'range');
assert.equal(run('validateField("workHours", 0).error'), 'range');
assert.equal(run('validateField("fx", "nope").error'), 'number');
assert.equal(run('validateField("workDays", 1.5).error'), 'integer');
assert.equal(run('validateField("horizon", FIELD_SCHEMA.horizon.max).valid'), true);
assert.equal(run('validateField("horizon", FIELD_SCHEMA.horizon.max + 1).error'), 'range');
assert.equal(run('validateField("users", "").valid'), false, 'blank input is invalid');
assert.equal(run('validateField("users", "2oops").valid'), false, 'partial numbers are invalid');
assert.equal(run('Object.entries(FIELD_SCHEMA).every(([id, rule]) => validateField(id, rule.min).valid && validateField(id, rule.max).valid && !validateField(id, rule.max + 1).valid)'), true, 'every field enforces bounds');

const baseline = run(`(() => {
  const s = { ...DEFAULTS };
  const m = models.find((x) => x.id === 'gpt-5.6-terra');
  return { api: apiCost(m, s).monthly, cloud: cloudCost(s).monthly, own: ownCost(s).monthly, small: smallCost(s).monthly };
})()`);
assert.ok(Math.abs(baseline.api - 839.25) < 1e-9, `API baseline ${baseline.api}`);
assert.ok(Math.abs(baseline.cloud - 10000) < 1e-9, `cloud baseline ${baseline.cloud}`);
assert.ok(Math.abs(baseline.own - 8601.084444444445) < 1e-9, `own baseline ${baseline.own}`);
const smallBaseline = run(`(() => {
  const s = { ...DEFAULTS };
  const small = smallCost(s);
  return { monthly: small.monthly, units: small.units, capex: small.capex, m0: cumulativeCost('small', small, 0), m12: cumulativeCost('small', small, 12), units300: smallCost(s, 300).units };
})()`);
assert.ok(Math.abs(smallBaseline.monthly - 1647.3262222222222) < 1e-9, `Dell GB10 baseline ${smallBaseline.monthly}`);
assert.equal(smallBaseline.units, 1, 'one GB10 unit at scenario S1');
assert.equal(smallBaseline.capex, 35000, 'Dell GB10 package costs 35 000 PLN');
assert.equal(smallBaseline.m0, 35000, 'GB10 cumulative cost starts at the purchase price');
assert.ok(Math.abs(smallBaseline.m12 - (35000 + 12 * (175.104 + 500))) < 1e-9, 'GB10 first year = purchase + 12 × running');
assert.equal(smallBaseline.units300, 3, 'scenario S3 needs three GB10 units');

const resultShape = run(`(() => {
  const result = computeResults({ ...DEFAULTS }, models);
  return { keys: Object.keys(result).sort(), winner: result.winner, rows: result.modelRows.length };
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(resultShape.keys)), ['api', 'base', 'breakEvenCloud', 'breakEvenOwn', 'breakEvenSmall', 'cloud', 'model', 'modelRows', 'own', 'payback', 'paybackSmall', 'small', 'winner', 'workload'], 'computeResults shape');
assert.equal(resultShape.rows, models.length, 'computeResults returns all model rows');
const steps = run(`(() => {
  const s = { ...DEFAULTS }, m = models.find((model) => model.id === 'gpt-5.6-terra');
  const result = computeResults(s, models);
  const be = result.breakEvenCloud;
  const at = (path, users) => totalCost(path, s, users, m).monthly;
  return [be > 0 && be < 20000, at('api', be) <= at('cloud', be), at('api', be + 1) > at('cloud', be + 1), at('api', 463) < at('cloud', 463)];
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(steps)), [true, true, true, true], 'break-even is the end of the first interval and does not imply permanent advantage');
const software = run(`(() => {
  const s = { ...DEFAULTS }, m = models.find((model) => model.id === 'gpt-5.6-terra');
  const r = computeResults(s, models);
  return { api: r.api.monthly - apiCost(m, s).monthly, cloud: r.cloud.monthly - cloudCost(s).monthly, own: r.own.monthly - ownCost(s).monthly, small: r.small.monthly - smallCost(s).monthly,
    small0: cumulativeCost('small', r.small, 0), small12: cumulativeCost('small', r.small, 12), rowSoft: r.modelRows[0].c.software.saas };
})()`);
assert.ok(Math.abs(software.api - 3000) < 1e-9 && Math.abs(software.cloud - 5000) < 1e-9, 'Zagłoba RAG SaaS: 3 000 with API, 5 000 with cloud');
assert.ok(Math.abs(software.own - (150000 / 36 + 20000 / 12)) < 1e-9 && Math.abs(software.small - software.own) < 1e-9, 'Zagłoba RAG licence 150 000 + 20 000/year on hardware paths');
assert.equal(software.small0, 35000 + 150000, 'GB10 cumulative cost starts at hardware + licence');
assert.ok(Math.abs(software.small12 - (185000 + 12 * (175.104 + 500 + 20000 / 12))) < 1e-9, 'GB10 first year adds support but not the licence again');
assert.equal(software.rowSoft, 3000, 'model table rows include the SaaS fee');
assert.throws(() => run('computeResults({ ...DEFAULTS, users: 0 }, models)'), /invalid|state/i, 'invalid state blocks results');

const tierRates = run(`(() => {
  const s = { ...DEFAULTS, chunks: 1, chunkTok: 272000, promptTok: 0, outTok: 0 };
  const m = models.find((x) => x.id === 'gpt-5.6-terra');
  const exact = apiCost(m, s);
  const above = apiCost(m, { ...s, chunkTok: 272001 });
  return { exact: [exact.pin, exact.pout, exact.tiered], above: [above.pin, above.pout, above.tiered] };
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(tierRates.exact)), [2, 12, false], '272K uses standard tier');
assert.deepEqual(JSON.parse(JSON.stringify(tierRates.above)), [4, 18, true], '272001 uses long-context tier');

const fableThinking = run(`(() => {
  const s = { ...DEFAULTS, thinking: false, thinkMult: 3 };
  const m = models.find((x) => x.id === 'claude-fable-5-1');
  const c = apiCost(m, s);
  return [c.outTok, c.outputOver, c.eligible];
})()`);
assert.ok(Math.abs(fableThinking[0] - (1500 * 3.02 / 2.32)) < 1e-9 && fableThinking[1] === false && fableThinking[2] === true, 'Fable forces reasoning without output overflow');

const invalidApi = run(`(() => {
  const m = models.find((x) => x.id === 'claude-haiku-4-5-20251001');
  const ctx = apiCost(m, { ...DEFAULTS, chunks: 1, chunkTok: 200001, promptTok: 0, outTok: 0 });
  const out = apiCost(m, { ...DEFAULTS, chunks: 1, chunkTok: 0, promptTok: 0, outTok: 64001 });
  return { ctx: [ctx.ctxOver, ctx.reason, ctx.eligible], out: [out.outputOver, out.reason, out.eligible] };
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(invalidApi.ctx)), [true, 'ctxOver', false], 'context overflow excludes API');
assert.deepEqual(JSON.parse(JSON.stringify(invalidApi.out)), [true, 'outputOver', false], 'output overflow excludes API');

const csvWith = (body) => `nazwa,cena_wejscie_per_1M_USD,cena_wyjscie_per_1M_USD,okno_kontekstu,klasa,uwaga,id,family,max_output,always_thinks,tier_above,tier_input,tier_output,offpeak_input,offpeak_output,checked_at,source\n${body}`;
assert.throws(() => run(`modelsFromCsv(${JSON.stringify(csvWith('Bad,-1,1,1000,mini,,bad,openai,128000,false,,,,,,2026-09-13,https://example.test'))})`), /row 2/i, 'negative CSV price has row');
assert.throws(() => run(`modelsFromCsv(${JSON.stringify(csvWith('Bad,1,1,1000,mini,"unterminated,bad,openai,128000,false,,,,,,2026-09-13,https://example.test'))})`), /quote|row 2/i, 'malformed CSV quote rejected');
assert.throws(() => run(`modelsFromCsv(${JSON.stringify(csvWith('Bad,1,1,1000,mini,,bad,unknown,128000,false,,,,,,2026-09-13,https://example.test'))})`), /family|unknown|row 2/i, 'unknown family rejected');

const cloudModes = run(`(() => {
  const s = { ...DEFAULTS, cloudOps: 700, cloudMode: 'work' };
  const work = cloudCost(s);
  const full = cloudCost({ ...s, cloudMode: '247' });
  return { work: work.monthly, full: full.monthly, workGpu: work.gpuMonthly };
})()`);
assert.ok(Math.abs(cloudModes.work - 2983.1050228310503) < 1e-9, `work cloud fixed ops ${cloudModes.work}`);
assert.ok(Math.abs(cloudModes.full - 10700) < 1e-9, `24/7 cloud fixed ops ${cloudModes.full}`);
assert.ok(Math.abs(cloudModes.workGpu - 2283.1050228310503) < 1e-9, `work GPU-only price ${cloudModes.workGpu}`);

const replacement = run(`(() => {
  const s = { ...DEFAULTS, ownReplace: 6 };
  const own = ownCost(s);
  return { own, m0: cumulativeCost('own', own, 0), m6: cumulativeCost('own', own, 6), m7: cumulativeCost('own', own, 7), m12: cumulativeCost('own', own, 12), payback: paybackMonth(own, 7000, 120) };
})()`);
assert.equal(replacement.own.replacementMonths, 6, 'replacement period is separate');
assert.equal(replacement.m0, replacement.own.capex, 'initial purchase at month zero');
assert.ok(replacement.m7 > replacement.m6, 'six-month replacement is reflected after period');
assert.ok(replacement.m12 > replacement.m7, 'second replacement in first year');
assert.equal(replacement.payback, null, 'replacement steps can prevent payback');

const regression = run('runRegressionChecks()');
assert.ok(Array.isArray(regression) && regression.length > 0, 'regression checks exposed');
assert.ok(regression.every((check) => check.pass === true), JSON.stringify(regression));

console.log('Core validation, CSV, cost-model, and regression checks passed');
