// Compare immutable revisions with identical dependencies and synthetic labels.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(frontend, '..');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const baseline = option('--baseline'), candidate = option('--candidate');
if (!baseline || !candidate) throw new Error('Usage: node scripts/benchmark-label-preview.mjs --baseline REF --candidate REF --output results.json');
const rounds = Number(option('--rounds') ?? 3), samples = Number(option('--samples') ?? 30);
assert.ok(Number.isInteger(rounds) && rounds > 0 && Number.isInteger(samples) && samples >= 5);
const commit = ref => execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim();
const revisions = { baseline: commit(baseline), candidate: commit(candidate) };
const directory = await realpath(await mkdtemp(join(tmpdir(), 'filaman-label-benchmark-')));
const servers = [];
let browser;

try {
  for (const [name, sha] of Object.entries(revisions)) {
    const root = join(directory, name);
    await mkdir(root);
    const archive = join(directory, `${name}.tar`);
    execFileSync('git', ['archive', '--format=tar', '--output', archive, sha, 'frontend'], { cwd: repository });
    execFileSync('tar', ['-xf', archive, '-C', root]);
    assert.equal(await readFile(join(root, 'frontend/package-lock.json'), 'utf8'), await readFile(join(frontend, 'package-lock.json'), 'utf8'), 'Use the same lockfile/dependencies for both revisions');
    await symlink(join(frontend, 'node_modules'), join(root, 'frontend/node_modules'), 'dir');
    const server = await createServer({
      configFile: false, root: join(root, 'frontend'), cacheDir: join(directory, `${name}-vite-cache`), logLevel: 'error',
      plugins: [{ name: 'label-benchmark', configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== '/label-benchmark') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><title>Local synthetic label benchmark</title><main></main>');
        });
      } }],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [directory, frontend] } },
      optimizeDeps: { noDiscovery: true, include: ['fontkit', 'qrcode', '@resvg/resvg-wasm', 'html-to-image', 'jspdf'] },
    });
    const instance = { name, server, origin: '' };
    servers.push(instance);
    await server.listen();
    instance.origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true });
  const cases = [
    { name: 'small-artwork', widthMm: 60, heightMm: 40, textCount: 2, artwork: true },
    { name: 'medium-artwork', widthMm: 100, heightMm: 70, textCount: 2, artwork: true },
    { name: 'large-artwork', widthMm: 280, heightMm: 180, textCount: 2, artwork: true },
    { name: 'text-heavy', widthMm: 100, heightMm: 70, textCount: 60, artwork: false },
  ];
  const logoUrl = 'data:image/png;base64,' + (await readFile(join(frontend, 'public/logo-qr.png'))).toString('base64');
  const runs = [];
  for (let round = 0; round < rounds; round++) for (const fixture of cases) {
    // Alternate order to reduce warm-up and machine-load bias.
    for (const revision of round % 2 ? [...servers].reverse() : servers) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
      page.on('pageerror', error => console.error(error.stack));
      page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
      try {
        await page.goto(`${revision.origin}/label-benchmark`);
        await page.evaluate(async ({ fixture, logoUrl }) => {
          const { renderDesignerLabel } = await import('/src/lib/label-designer.ts');
          const { clearSvgDesignerLabel, renderSvgElementOutput } = await import('/src/lib/label-svg/browser.ts');
          const { rasterize } = await import('/src/lib/label-svg/core.mjs');
          let fetches = 0, decodes = 0;
          const urls = new Set(), originalFetch = fetch, originalBitmap = createImageBitmap;
          const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
          window.fetch = (...args) => { if (String(args[0]).includes('logo-qr.png') || String(args[0]).startsWith('data:')) fetches++; return originalFetch(...args); };
          window.createImageBitmap = (...args) => { decodes++; return originalBitmap(...args); };
          URL.createObjectURL = blob => { const url = createUrl(blob); urls.add(url); return url; };
          URL.revokeObjectURL = url => { urls.delete(url); revokeUrl(url); };
          const element = document.createElement('div');
          document.querySelector('main').append(element);
          const text = (id, x, y, w, h, template, fontSizeMm = 3) => ({ id, type: 'text', x, y, w, h, z: 0, template,
            fontFamily: 'Space Grotesk', fontSizeMm, fontWeight: 400, italic: false, underline: false, align: 'left', color: '#000000', wrap: true, fitToWidth: true, minFontSizeMm: 1 });
          const elements = fixture.textCount === 2 ? [
            text('name', 3, 9, 30, 7, '{filament.name}'),
            text('temperatures', 3, 17, 28, 12, '{filament.extruder_temp_range_c|unit}\n{filament.bed_temp_range_c|unit}'),
            { id: 'qr', type: 'qr', x: 39, y: 12, w: 18, h: 18, z: 2, mode: fixture.artwork ? 'colorLogo' : 'simple', linkMode: 'url', urlTemplate: 'https://fila.test' },
            ...(fixture.artwork ? [{ id: 'logo', type: 'manufacturerLogo', x: 3, y: 2, w: 25, h: 5, z: 3, objectFit: 'contain' }] : []),
          ] : Array.from({ length: fixture.textCount }, (_, i) => text('text-' + i, 2 + i % 5 * 19, 2 + Math.floor(i / 5) * 5.4, 18, 5, 'PLA ' + i, 1.8));
          const design = { version: 2, label: { widthMm: fixture.widthMm, heightMm: fixture.heightMm, marginMm: 1, border: false }, elements };
          const data = { id: 295, 'filament.name': 'Galaxy PLA', 'filament.extruder_temp_range_c': '220-260', 'filament.bed_temp_range_c': '60-80' };
          const options = { element, design, data, interactive: true, logoUrl: fixture.artwork ? logoUrl : null };
          const render = async index => {
            design.elements[0].x = 3 + index % 2 * 0.1;
            const start = performance.now();
            await renderDesignerLabel(options);
            if (element.querySelector('[data-label-output-error]')) throw new Error(element.textContent);
            const processed = performance.now();
            await element.querySelector('[data-label-svg-raster]').decode();
            return { processMs: processed - start, readyMs: performance.now() - start };
          };
          window.labelBenchmark = { fixture, element, design, options, render, clearSvgDesignerLabel, renderSvgElementOutput, rasterize,
            counters: () => ({ fetches, decodes, activeUrls: urls.size }), reset: () => { fetches = 0; decodes = 0; } };
        }, { fixture, logoUrl });
        const timing = await page.evaluate(async samples => {
          const bench = window.labelBenchmark, firstRender = await bench.render(0);
          for (let i = 0; i < 8; i++) await bench.render(i);
          bench.reset();
          const measurements = [];
          for (let i = 0; i < samples; i++) {
            await new Promise(requestAnimationFrame);
            measurements.push(await bench.render(i));
          }
          const boxes = [...bench.element.querySelectorAll('[data-label-element-id]')].map(node => ({ id: node.dataset.labelElementId,
            x: node.style.left, y: node.style.top, w: node.style.width, h: node.style.height }));
          return { firstRender, measurements, boxes, counters: bench.counters() };
        }, samples);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('HeapProfiler.collectGarbage');
        const warmHeap = await cdp.send('Runtime.getHeapUsage');
        let retainedHeap = null;
        if (fixture.name === 'small-artwork') {
          await page.evaluate(async () => { for (let i = 0; i < 150; i++) await window.labelBenchmark.render(i); });
          await cdp.send('HeapProfiler.collectGarbage');
          retainedHeap = await cdp.send('Runtime.getHeapUsage');
        }
        const output = await page.evaluate(async () => {
          const bench = window.labelBenchmark, output = [];
          const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
          for (const dpi of [203, 300, 600]) {
            const width = Math.round(bench.fixture.widthMm * dpi / 25.4), height = Math.round(bench.fixture.heightMm * dpi / 25.4);
            if (width * height > 8000000) continue;
            for (const thermal of [false, true]) {
              const durations = [];
              let rendered;
              for (let i = 0; i < 5; i++) {
                const start = performance.now();
                rendered = await bench.renderSvgElementOutput(bench.element, width, height, thermal);
                durations.push(performance.now() - start);
              }
              output.push({ dpi, thermal, width, height, png: await hash(rendered.png),
                mono1: await hash(bench.rasterize(rendered.svg).mono), svg: await hash(new TextEncoder().encode(rendered.svg)), durations });
            }
          }
          bench.clearSvgDesignerLabel(bench.element);
          return { output, disposedUrls: bench.counters().activeUrls };
        });
        assert.equal(output.disposedUrls, 0, `${revision.name}: preview URL leak`);
        for (const sample of timing.measurements) assert.ok(Number.isFinite(sample.processMs) && Number.isFinite(sample.readyMs));
        runs.push({ revision: revision.name, round: round + 1, fixture: fixture.name, ...timing, warmHeap, retainedHeap, ...output });
        console.log(`${revision.name} round ${round + 1}: ${fixture.name}`);
      } finally { await page.close(); }
    }
  }
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const summary = cases.map(fixture => {
    const row = { fixture: fixture.name, widthMm: fixture.widthMm, heightMm: fixture.heightMm };
    for (const name of Object.keys(revisions)) {
      const selected = runs.filter(run => run.revision === name && run.fixture === fixture.name);
      const values = selected.flatMap(run => run.measurements);
      row[name] = { samples: values.length, processMedianMs: percentile(values.map(x => x.processMs), 0.5), processP95Ms: percentile(values.map(x => x.processMs), 0.95),
        readyMedianMs: percentile(values.map(x => x.readyMs), 0.5), readyP95Ms: percentile(values.map(x => x.readyMs), 0.95),
        artworkDecodes: selected.reduce((n, run) => n + run.counters.decodes, 0),
        export300MedianMs: percentile(selected.flatMap(run => run.output.filter(output => output.dpi === 300 && !output.thermal).flatMap(output => output.durations)), 0.5),
        warmHeapMedianBytes: percentile(selected.map(run => run.warmHeap.usedSize), 0.5),
        retainedHeapGrowthMedianBytes: fixture.name === 'small-artwork' ? percentile(selected.map(run => run.retainedHeap.usedSize - run.warmHeap.usedSize), 0.5) : null };
    }
    const reference = runs.find(run => run.fixture === fixture.name && run.revision === 'baseline');
    for (const run of runs.filter(run => run.fixture === fixture.name)) {
      assert.deepEqual(run.boxes, reference.boxes, `${fixture.name}: editor geometry changed`);
      const hashes = outputs => outputs.map(({ durations: _durations, ...output }) => output);
      assert.deepEqual(hashes(run.output), hashes(reference.output), `${fixture.name}: strict SVG/PNG/mono1 output changed`);
    }
    row.processSpeedup = row.baseline.processMedianMs / row.candidate.processMedianMs;
    row.readySpeedup = row.baseline.readyMedianMs / row.candidate.readyMedianMs;
    return row;
  });
  const result = { measuredAt: new Date().toISOString(), revisions, environment: { platform: platform(), release: release(), arch: process.arch,
    cpu: cpus()[0]?.model, node: process.version, browser: browser.version(), deviceScaleFactor: 1, cpuThrottling: 'none',
    dependencyLockGitBlob: execFileSync('git', ['hash-object', 'frontend/package-lock.json'], { cwd: repository, encoding: 'utf8' }).trim() },
    methodology: { rounds, samplesPerRound: samples, warmupRenders: 8, retentionRenders: 150, exportSamplesPerFormat: 5, order: 'alternating baseline/candidate per round',
      processMs: 'renderDesignerLabel promise; includes artwork preparation, excludes subsequent preview image.decode() and paint', readyMs: 'includes image.decode(); excludes presentation/vsync',
      memory: 'Chrome Runtime.getHeapUsage after forced GC; JavaScript heap only, not total process/GPU/native peak RAM',
      scope: 'Vite serves immutable Git archives; both revisions share installed dependencies; synthetic data only' },
    checks: { strictOutputComparisons: runs.filter(run => run.revision === 'candidate').reduce((n, run) => n + run.output.length, 0),
      strictSvgPngMono1Equal: true, editorGeometryEqual: true, previewUrlsReleased: true }, summary, runs };
  const destination = resolve(option('--output') ?? 'label-preview-benchmark.json');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output: destination, checks: result.checks, summary }, null, 2));
} finally {
  await browser?.close();
  await Promise.all(servers.map(({ server }) => server.close()));
  await rm(directory, { recursive: true, force: true });
}
