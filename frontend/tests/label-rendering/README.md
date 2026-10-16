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
export CHROME_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export LABEL_EVIDENCE_DIR=/tmp/label-rendering-evidence
node tests/label-rendering/check.mjs
node tests/label-rendering/compatibility-check.mjs
```

Use the path to your installed test browser. Evidence includes PNGs, SVGs,
packed `.mono1` files and JSON results; keep it outside version control.
Chromium is only a test browser, not an application rendering dependency.

To check the tester's original exports, start the server with
`LABEL_TESTER_PRESETS_DIR` pointing to a directory containing `presets.json` and
`presets_tiny_qr.json`, then run `node tests/label-rendering/saved-presets-check.mjs`.
This optional suite expects the original tester IDs (including 3, 4 and 5).
Inputs are read-only and hash-recorded. Labels use representative data and a
synthetic logo; they are not reproductions of the tester's physical prints.

## Application and authenticated API checks

Stop the parity server, run `npm run build:label-svg`, then start Astro with
`node_modules/.bin/astro dev --host 127.0.0.1 --port 4408`.
With the browser/evidence variables above set, run
`node scripts/check-shared-label-pilot.mjs` to exercise spool/filament editing,
PNG/PDF exports and sheet composition. API responses and `window.print` are stubbed.

For actual API wire comparisons, from `backend` run:

```sh
LABEL_EVIDENCE_DIR=/tmp/label-api-evidence \
LABEL_RENDER_NODE_EXECUTABLE=/path/to/node20 \
.venv/bin/pytest tests/test_shared_label_pilot.py -q
```

This uses an isolated database. Then run `node scripts/check-shared-label-api.mjs`
from `frontend` with `LABEL_EVIDENCE_DIR=/tmp/label-api-evidence` and the browser
path set. It compares browser output with API bytes across DPI, threshold,
padding, rotation and rejected layouts. `LABEL_TESTER_PRESETS_DIR` is optional.

Pixel parity does not prove physical print quality or QR scan reliability.
Container checks must use an isolated database, never a live Compose data mount.
