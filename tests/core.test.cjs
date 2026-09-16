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
assert.ok(Math.abs(baseline.own - 7601.084444444445) < 1e-9, `own baseline ${baseline.own}`);
const smallBaseline = run(`(() => {
  const s = { ...DEFAULTS };
  const small = smallCost(s);
  return { monthly: small.monthly, units: small.units, capex: small.capex, m0: cumulativeCost('small', small, 0), m12: cumulativeCost('small', small, 12), units300: smallCost(s, 300).units };
})()`);
assert.ok(Math.abs(smallBaseline.monthly - 1147.3262222222222) < 1e-9, `Dell GB10 baseline ${smallBaseline.monthly}`);
assert.equal(smallBaseline.units, 1, 'one GB10 unit at scenario S1');
assert.equal(smallBaseline.capex, 35000, 'Dell GB10 package costs 35 000 PLN');
assert.equal(smallBaseline.m0, 35000, 'GB10 cumulative cost starts at the purchase price');
assert.ok(Math.abs(smallBaseline.m12 - (35000 + 12 * 175.104)) < 1e-9, 'GB10 first year = purchase + 12 × running');
assert.equal(smallBaseline.units300, 4, 'scenario S3 needs four GB10 units at the 80% utilization ceiling');
const smallLimit = run(`(() => {
  const s = { ...DEFAULTS };
  const ok = totalCost('small', s, 100), over = totalCost('small', s, 101), r = computeResults({ ...s, users: 300 }, models);
  return [ok.eligible, over.eligible, over.reason, r.winner !== 'small', r.paybackSmall];
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(smallLimit)), [true, false, 'smallTooMany', true, null], 'Dell GB10 is unavailable from 101 users');
const smallRecommend = run(`(() => {
  const s = { ...DEFAULTS };
  const at = (users) => { const r = computeResults({ ...s, users }, models); return [r.winner, r.recommended]; };
  const custom = computeResults({ ...s, users: 60, smallRecommendFrom: 70 }, models);
  return { u20: at(20), u49: at(49), u50: at(50), u100: at(100), u101: at(101), custom: [custom.winner, custom.recommended] };
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(smallRecommend)), { u20: ['api', null], u49: ['small', null], u50: ['small', 'api'], u100: ['small', 'api'], u101: ['api', null], custom: ['small', null] }, 'next cheapest option is recommended from 50 users while GB10 wins');

const resultShape = run(`(() => {
  const result = computeResults({ ...DEFAULTS }, models);
  return { keys: Object.keys(result).sort(), winner: result.winner, rows: result.modelRows.length };
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(resultShape.keys)), ['api', 'base', 'breakEvenCloud', 'breakEvenOwn', 'breakEvenSmall', 'cloud', 'model', 'modelRows', 'own', 'payback', 'paybackSmall', 'recommended', 'small', 'winner', 'workload'], 'computeResults shape');
assert.equal(resultShape.rows, models.length, 'computeResults returns all model rows');
const steps = run(`(() => {
  const s = { ...DEFAULTS }, m = models.find((model) => model.id === 'gpt-5.6-terra');
  const result = computeResults(s, models);
  const be = result.breakEvenCloud;
  const at = (path, users) => totalCost(path, s, users, m).monthly;
  return [be > 0 && be < 20000, at('api', be) <= at('cloud', be), at('api', be + 1) > at('cloud', be + 1)];
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(steps)), [true, true, true], 'break-even is the end of the first API-over-cloud interval');
const software = run(`(() => {
  const s = { ...DEFAULTS }, m = models.find((model) => model.id === 'gpt-5.6-terra');
  const r = computeResults(s, models);
  return { api: r.api.monthly - apiCost(m, s).monthly - s.apiOps, cloud: r.cloud.monthly - cloudCost(s).monthly, own: r.own.monthly - ownCost(s).monthly, small: r.small.monthly - smallCost(s).monthly,
    small0: cumulativeCost('small', r.small, 0), small12: cumulativeCost('small', r.small, 12), rowSoft: r.modelRows[0].c.software.saas };
})()`);
assert.ok(Math.abs(software.api - 5000) < 1e-9 && Math.abs(software.cloud - 5000) < 1e-9, 'Zagłoba RAG SaaS: 5 000 with API and with cloud');
assert.ok(Math.abs(software.own - (150000 / 36 + 20000 / 12)) < 1e-9 && Math.abs(software.small - software.own) < 1e-9, 'Zagłoba RAG licence 150 000 + 20 000/year on hardware paths');
assert.equal(software.small0, 35000 + 150000, 'GB10 cumulative cost starts at hardware + licence');
assert.ok(Math.abs(software.small12 - (185000 + 12 * (175.104 + 20000 / 12))) < 1e-9, 'GB10 first year adds support but not the licence again');
assert.equal(software.rowSoft, 5000, 'model table rows include the SaaS fee');
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

assert.equal(run('DEFAULTS.maxUtilization'), 80, 'default hardware utilization ceiling is 80%');
assert.deepEqual(JSON.parse(JSON.stringify(run('FIELD_SCHEMA.maxUtilization'))), { min: 1, max: 100, integer: true }, 'utilization ceiling field is an integer percentage');
assert.equal(run('validateField("maxUtilization", 1).valid'), true, 'minimum utilization ceiling is valid');
assert.equal(run('validateField("maxUtilization", 100).valid'), true, 'maximum utilization ceiling is valid');
assert.equal(run('validateField("maxUtilization", 80.5).error'), 'integer', 'fractional utilization ceiling is rejected');
assert.equal(run('validateField("maxUtilization", 0).error'), 'range', 'zero utilization ceiling is rejected');
assert.equal(run('validateField("maxUtilization", 101).error'), 'range', 'over-100 utilization ceiling is rejected');

const gpuBoundary = run(`(() => {
  const exact = gpuUnits({ inPeakPerSec: 8, outPeakPerSec: 0 }, 10, 1);
  const above = gpuUnits({ inPeakPerSec: 8.000000001, outPeakPerSec: 0 }, 10, 1);
  const full = gpuUnits({ inPeakPerSec: 10, outPeakPerSec: 0 }, 10, 1, 100);
  const fullAbove = gpuUnits({ inPeakPerSec: 10.000000001, outPeakPerSec: 0 }, 10, 1, 100);
  const zero = gpuUnits({ inPeakPerSec: 0, outPeakPerSec: 0 }, 10, 1);
  return { exact, above, full, fullAbove, zero };
})()`);
assert.equal(gpuBoundary.exact.load, 0.8, 'exact 80% load is accepted on one unit');
assert.equal(gpuBoundary.exact.units, 1, 'exact utilization boundary does not over-provision');
assert.equal(gpuBoundary.exact.utilization, 0.8, 'utilization is returned as a fraction');
assert.equal(gpuBoundary.exact.utilizationLimit, 0.8, 'utilization limit is returned as a fraction');
assert.equal(gpuBoundary.above.units, 2, 'load above the utilization boundary adds a unit');
assert.ok(gpuBoundary.above.load > (gpuBoundary.above.units - 1) * gpuBoundary.above.utilizationLimit, 'the unit count is minimal above the boundary');
assert.equal(gpuBoundary.full.units, 1, '100% ceiling accepts exact full-unit load');
assert.equal(gpuBoundary.fullAbove.units, 2, '100% ceiling still adds a unit above full load');
assert.deepEqual(JSON.parse(JSON.stringify(gpuBoundary.zero)), { load: 0, units: 1, utilization: 0, utilizationLimit: 0.8 }, 'zero token load keeps one idle unit');

const workloadVariants = run(`(() => {
  const s = { ...DEFAULTS, users: 100 };
  const both = workload(s);
  const inputOnly = workload({ ...s, outTok: 0 });
  const outputOnly = workload({ ...s, chunks: 0, chunkTok: 0, promptTok: 0 });
  const thinking = workload({ ...s, thinking: true });
  const noThinking = workload({ ...s, thinking: false });
  const higherPeak = workload({ ...s, peak: 3 });
  const english = workload({ ...s, docLang: 'en' });
  return { both, inputOnly, outputOnly, thinking, noThinking, higherPeak, english };
})()`);
assert.ok(workloadVariants.both.inPeakPerSec > 0 && workloadVariants.both.outPeakPerSec > 0, 'default workload has input and output load');
assert.equal(workloadVariants.inputOnly.outPeakPerSec, 0, 'input-only workload removes output load');
assert.ok(workloadVariants.inputOnly.inPeakPerSec > 0, 'input-only workload keeps input load');
assert.equal(workloadVariants.outputOnly.inPeakPerSec, 0, 'output-only workload removes input load');
assert.ok(workloadVariants.outputOnly.outPeakPerSec > 0, 'output-only workload keeps output load');
assert.ok(workloadVariants.thinking.outPeakPerSec > workloadVariants.noThinking.outPeakPerSec, 'thinking increases output load');
assert.ok(workloadVariants.higherPeak.inPeakPerSec > workloadVariants.both.inPeakPerSec && workloadVariants.higherPeak.outPeakPerSec > workloadVariants.both.outPeakPerSec, 'peak multiplier increases both loads');
assert.notEqual(workloadVariants.english.inPeakPerSec, workloadVariants.both.inPeakPerSec, 'document language affects token workload');

const capacityFixtures = run(`(() => {
  const s = { ...DEFAULTS };
  const at100 = { ...s, users: 100 };
  const at400 = { ...s, users: 400 };
  const at300 = { ...s, users: 300 };
  return {
    small100: smallCost(at100),
    small300: smallCost(at300),
    small300Total: totalCost('small', at300),
    small100Full: smallCost({ ...at100, maxUtilization: 100 }),
    cloud400: cloudCost(at400),
    cloud400Full: cloudCost({ ...at400, maxUtilization: 100 }),
  };
})()`);
assert.equal(capacityFixtures.small100.units, 2, 'GB10 adds a second unit for 100 users at 80%');
assert.equal(capacityFixtures.small100Full.units, 1, '100% ceiling restores the previous GB10 count');
assert.equal(capacityFixtures.cloud400.units, 2, 'cloud adds a second GPU for 400 users at 80%');
assert.equal(capacityFixtures.cloud400Full.units, 1, '100% ceiling restores the previous cloud count');
assert.equal(capacityFixtures.small300.units, 4, 'GB10 S3 scales to four units at 80%');
assert.equal(capacityFixtures.small100.supportedUsers, 186, 'raw GB10 capacity is derived from unit headroom');
assert.equal(capacityFixtures.small100.remainingUsers, 86, 'raw GB10 remaining capacity is users minus supported users');
assert.equal(capacityFixtures.cloud400.supportedUsers, 740, 'cloud capacity reports users supported by two GPUs');
assert.equal(capacityFixtures.cloud400.remainingUsers, 340, 'cloud remaining capacity is exposed');
assert.ok(capacityFixtures.small300.supportedUsers > defaults.smallMaxUsers, 'raw GB10 capacity may exceed its deployment policy');
assert.equal(capacityFixtures.small300Total.supportedUsers, defaults.smallMaxUsers, 'total GB10 capacity is capped by the eligible-user policy');
assert.equal(capacityFixtures.small300Total.remainingUsers, 0, 'capped GB10 capacity has no remaining users at S3');
assert.equal(capacityFixtures.small300Total.eligible, false, 'GB10 remains ineligible above its selected-user policy');

const nonDefaultCeilings = run(`(() => {
  const s = { ...DEFAULTS, users: 1024 };
  return [11, 22, 44, 88].map((maxUtilization) => {
    const cost = smallCost({ ...s, maxUtilization });
    return { maxUtilization, load: cost.load, units: cost.units, utilization: cost.utilization, utilizationLimit: cost.utilizationLimit,
      supportedUsers: cost.supportedUsers, remainingUsers: cost.remainingUsers };
  });
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(nonDefaultCeilings.map((row) => row.units))), [80, 40, 20, 10], 'non-default ceilings provision the minimal GB10 unit counts');
for (const row of nonDefaultCeilings) {
  assert.equal(row.load, 8.8, `GB10 load at 1024 users is exact for ${row.maxUtilization}%`);
  assert.ok(row.utilization <= row.utilizationLimit, `utilization stays within ${row.maxUtilization}% ceiling`);
  assert.ok(row.units === 1 || row.load > (row.units - 1) * row.utilizationLimit, `unit count is minimal at ${row.maxUtilization}%`);
  assert.ok(row.supportedUsers >= 1024, `GB10 supports the selected 1024 users at ${row.maxUtilization}%`);
  assert.equal(row.remainingUsers, row.supportedUsers - 1024, `remaining capacity is invertible at ${row.maxUtilization}%`);
}

const capacityInversion = run(`(() => {
  const s = { ...DEFAULTS, users: 1024, maxUtilization: 57 };
  return Object.entries({ cloud: cloudCost, own: ownCost, small: smallCost }).map(([name, cost]) => {
    const selected = cost(s);
    const atCapacity = cost({ ...s, users: selected.supportedUsers });
    const aboveCapacity = cost({ ...s, users: selected.supportedUsers + 1 });
    return { name, selected, atCapacity, aboveCapacity };
  });
})()`);
for (const row of capacityInversion) {
  assert.equal(row.atCapacity.supportedUsers, row.selected.supportedUsers, `${row.name} capacity is stable when inverted at 57%`);
  assert.equal(row.atCapacity.remainingUsers, 0, `${row.name} has no remaining users at its inverted capacity`);
  assert.equal(row.atCapacity.units, row.selected.units, `${row.name} keeps the same unit count at capacity`);
  assert.ok(row.aboveCapacity.units > row.atCapacity.units, `${row.name} adds hardware above inverted capacity`);
}

const ceilingCoverage = run(`(() => {
  const fixtures = [
    { users: 1, docLang: 'pl', thinking: false },
    { users: 37, docLang: 'pl', thinking: true },
    { users: 199, docLang: 'en', thinking: false },
    { users: 1024, docLang: 'en', thinking: true },
    { users: 5000, docLang: 'pl', thinking: true },
    { users: 20000, docLang: 'en', thinking: false },
  ];
  const rows = [];
  for (let maxUtilization = 1; maxUtilization <= 100; maxUtilization++) {
    for (const fixture of fixtures) {
      for (const [name, cost] of Object.entries({ cloud: cloudCost, own: ownCost, small: smallCost })) {
        const c = cost({ ...DEFAULTS, ...fixture, maxUtilization });
        const withinCeiling = c.utilization <= c.utilizationLimit && c.load <= c.units * c.utilizationLimit;
        const minimal = c.units === 1 || c.load > (c.units - 1) * c.utilizationLimit;
        const supported = c.supportedUsers === null || (Number.isInteger(c.supportedUsers) && c.supportedUsers >= fixture.users);
        const remaining = c.supportedUsers === null ? c.remainingUsers === null : c.remainingUsers === c.supportedUsers - fixture.users;
        if (!withinCeiling || !minimal || !supported || !remaining) rows.push({ name, maxUtilization, users: fixture.users, docLang: fixture.docLang, thinking: fixture.thinking, units: c.units, load: c.load, utilization: c.utilization, utilizationLimit: c.utilizationLimit, supportedUsers: c.supportedUsers, remainingUsers: c.remainingUsers });
      }
    }
  }
  return rows;
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(ceilingCoverage)), [], 'all 1..100% ceilings cover representative PL/EN and reasoning workloads');

const zeroTokenCapacity = run(`(() => {
  const s = { ...DEFAULTS, reqPerDay: 0 };
  return { cloud: cloudCost(s), own: ownCost(s), small: smallCost(s), smallTotal: totalCost('small', s) };
})()`);
for (const pathName of ['cloud', 'own', 'small']) {
  assert.equal(zeroTokenCapacity[pathName].units, 1, `${pathName} keeps one unit at zero token load`);
  assert.equal(zeroTokenCapacity[pathName].supportedUsers, null, `${pathName} reports null capacity at zero token load`);
  assert.equal(zeroTokenCapacity[pathName].remainingUsers, null, `${pathName} reports null remaining users at zero token load`);
}
assert.equal(zeroTokenCapacity.smallTotal.supportedUsers, defaults.smallMaxUsers, 'total GB10 keeps its policy ceiling with zero token load');
assert.equal(zeroTokenCapacity.smallTotal.remainingUsers, defaults.smallMaxUsers - defaults.users, 'total GB10 remaining policy capacity is visible with zero tokens');

const capacityCoverage = run(`(() => {
  const s = { ...DEFAULTS };
  const rows = [];
  for (let users = 1; users <= 20000; users++) {
    for (const [name, cost] of Object.entries({ cloud: cloudCost, own: ownCost, small: smallCost })) {
      const c = cost({ ...s, users });
      const loadWithinCeiling = c.load <= c.units * c.utilizationLimit;
      const minimal = c.units === 1 || c.load > (c.units - 1) * c.utilizationLimit;
      const supported = c.supportedUsers === null || (Number.isInteger(c.supportedUsers) && c.supportedUsers >= users);
      const remaining = c.supportedUsers === null ? c.remainingUsers === null : c.remainingUsers === c.supportedUsers - users;
      if (!loadWithinCeiling || !minimal || !supported || !remaining) rows.push({ name, users, units: c.units, load: c.load, limit: c.utilizationLimit, supported: c.supportedUsers, remaining: c.remainingUsers });
    }
  }
  return rows;
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(capacityCoverage)), [], 'hardware units are minimal, never under-provisioned, and cover users 1..20000');

const costScaling = run(`(() => {
  const s = { ...DEFAULTS, cloudOps: 123, ownOps: 321, smallOps: 17, softCloud: 456 };
  const cloudLow = cloudCost({ ...s, users: 100 }), cloudHigh = cloudCost({ ...s, users: 400 });
  const ownLow = ownCost({ ...s, users: 100 }), ownHigh = ownCost({ ...s, users: 400 });
  const smallLow = smallCost({ ...s, users: 50 }), smallHigh = smallCost({ ...s, users: 100 });
  const cloudTotalLow = totalCost('cloud', { ...s, users: 100 }), cloudTotalHigh = totalCost('cloud', { ...s, users: 400 });
  const ownTotalLow = totalCost('own', { ...s, users: 100 }), ownTotalHigh = totalCost('own', { ...s, users: 400 });
  const smallTotalLow = totalCost('small', { ...s, users: 50 }), smallTotalHigh = totalCost('small', { ...s, users: 100 });
  const replacementMonth = 37;
  const replacementDelta = (high, low) => cumulativeCost('small', high, replacementMonth) - cumulativeCost('small', low, replacementMonth);
  return { cloudLow, cloudHigh, ownLow, ownHigh, smallLow, smallHigh, cloudTotalLow, cloudTotalHigh, ownTotalLow, ownTotalHigh, smallTotalLow, smallTotalHigh,
    smallReplacementDelta: replacementDelta(smallTotalHigh, smallTotalLow),
    smallReplacementExpected: (smallTotalHigh.capex - smallTotalLow.capex) * Math.ceil(replacementMonth / smallTotalHigh.replacementMonths)
      + (smallTotalHigh.running - smallTotalLow.running) * replacementMonth };
})()`);
assert.equal(costScaling.cloudHigh.gpuMonthly, costScaling.cloudLow.gpuMonthly * 2, 'cloud rental scales with GPU count');
assert.equal(costScaling.cloudHigh.cloudOps, costScaling.cloudLow.cloudOps, 'cloud fixed operations stay unchanged');
assert.equal(costScaling.cloudTotalHigh.software.monthly, costScaling.cloudTotalLow.software.monthly, 'cloud software fee stays unchanged');
assert.equal(costScaling.ownHigh.energy, costScaling.ownLow.energy * 2, 'own-server energy scales with GPU count');
assert.equal(costScaling.ownHigh.capex, costScaling.ownLow.capex * 2, 'own-server capex scales with GPU count');
assert.equal(costScaling.ownHigh.ops, costScaling.ownLow.ops, 'own-server fixed operations stay unchanged');
assert.equal(costScaling.ownTotalHigh.software.monthly, costScaling.ownTotalLow.software.monthly, 'own-server software fee stays unchanged');
assert.equal(costScaling.smallHigh.energy, costScaling.smallLow.energy * 2, 'GB10 energy scales with unit count');
assert.equal(costScaling.smallHigh.capex, costScaling.smallLow.capex * 2, 'GB10 capex scales with unit count');
assert.equal(costScaling.smallHigh.ops, costScaling.smallLow.ops, 'GB10 fixed operations stay unchanged');
assert.equal(costScaling.smallTotalHigh.software.monthly, costScaling.smallTotalLow.software.monthly, 'GB10 software fee stays unchanged');
assert.ok(Math.abs(costScaling.smallReplacementDelta - costScaling.smallReplacementExpected) < 1e-9, 'replacement chart repeats scaled hardware capex and running cost consistently');

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
