# Label rendering checks

These development tests use the production renderer in `src/lib/label-svg`.
They compare SVG, RGBA pixels, mono1 bytes and errors across browser and Node.
Fixtures cover fonts/weights, mixed styles, umlauts, wrapping, fitting, drawings,
images, logos and normal/thermal QR codes. They do not send print commands.

## Unit tests

From `frontend`, with dependencies installed:

```sh
npx vitest run src/lib/label-svg
```

## Browser/Node parity

Start the loopback-only test server from `frontend`:

```sh
npm run test:label-rendering:serve
```

Open <http://127.0.0.1:4407/tests/label-rendering/> for interactive comparisons.
Do not expose this unauthenticated test server publicly. Stop other frontend dev
servers first: they share Vite's dependency cache.

In another terminal, from `frontend`:

```sh
export CHROME_EXECUTABLE_PATH=/path/to/chrome
node tests/label-rendering/check.mjs
node tests/label-rendering/compatibility-check.mjs
```

Use the path to your installed test browser. To also save PNGs, SVGs, packed
`.mono1` files and JSON results, set `LABEL_EVIDENCE_DIR` to a temporary directory
outside version control. Artifacts are optional, not a prerequisite for testing.
Chromium is only a test browser, not an application rendering dependency.

All cases use committed synthetic fixtures. Saved V1/V2 preset compatibility is
covered by the frontend migration tests and backend preset tests; no personal
database, preset export, or particular record ID is required.

## Application and authenticated API checks

Stop the parity server, then start Astro with
`npm run dev -- --host 127.0.0.1` (port 4321).
With the browser variable above set, run `npm run check:label-output` to exercise
spool/filament editing, PNG/PDF exports and sheet composition. API responses and
`window.print` are stubbed. This check is also part of `npm run check:browser`.

For actual API wire comparisons, first build the renderer with a frontend build
or `npm run build:label-svg` from `frontend`. Then, from `backend` run:

```sh
LABEL_EVIDENCE_DIR=/tmp/label-api-evidence \
LABEL_RENDER_NODE_EXECUTABLE=/path/to/node20 \
.venv/bin/pytest tests/test_shared_label_pilot.py -q
```

This uses an isolated database. Then run `npm run check:label-api-parity`
from `frontend` with `LABEL_EVIDENCE_DIR=/tmp/label-api-evidence` and the browser
path set. It compares browser output with API bytes across DPI, threshold,
padding, rotation and thresholds. Unlike the ordinary browser suite, this
cross-language check requires the fixture JSON produced by pytest above.

Pixel parity does not prove physical print quality or QR scan reliability.
Container checks must use an isolated database, never a live Compose data mount.

## Matched preview benchmark

Check out the three-commit PR branch. With frontend dependencies installed and
`CHROME_EXECUTABLE_PATH` set, run from `frontend`:

```sh
node scripts/benchmark-label-preview.mjs \
  --baseline HEAD~2 --candidate HEAD \
  --rounds 3 --samples 30 --output /tmp/label-preview-benchmark.json
```

The baseline includes the QR and text fixes. The candidate adds the preview
optimization, drag changes, and field editing. The script serves isolated Git snapshots on loopback with the same installed
dependencies (both lockfiles must match). It alternates revision order, records
processing and decoded-image latency, and samples JavaScript heap after GC.
Assertions reject changed editor geometry, changed strict SVG/PNG/mono1 bytes,
or unreleased preview Blob URLs. Timing is reported, not used as a flaky CI gate.
The existing unit/browser suites guard the optimization and print paths in CI.
See the [measured results and limitations](benchmarks/2026-11-06-preview.md).
