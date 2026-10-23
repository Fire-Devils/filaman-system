# Frontend tests

Run commands from `frontend` after `npm ci`.

## Unit and component tests

```sh
npm test
npm run check
npm run lint
```

Vitest discovers the `src/**/*.test.ts` files, including rendered Astro components
and DOM controllers. Keep regression tests alongside the code change they cover.

## Browser checks

Start an isolated Astro server on the default port (4321):

```sh
npm run dev -- --host 127.0.0.1
```

In another terminal:

```sh
CHROME_EXECUTABLE_PATH=/path/to/chrome npm run check:browser
```

This is the same command used by the frontend browser CI workflow. It checks label
layout/editor/print flows and filament/spool view, edit, mobile navigation, Save
state, numeric input validation, purchase currency and catalog image behavior.
Label checks also hold entity responses open to verify that a user's Designer
selection survives loading on single and batch pages for both entity types.
Browser API responses are fixtures: no account, database records or credentials
are needed. Writes and physical print calls are intercepted. It does not test
backend request handling or physical printers.

`npm run check:details` runs just the record-page checks. An individual page script
accepts another server URL, e.g. `node scripts/check-detail-toolbar.mjs http://127.0.0.1:4322`.
`CHECK_LANGUAGE=de` (or `fr`) selects another locale for the toolbar matrix.

For compiled-app print-request checks, run `npx astro build` followed by
`CHROME_EXECUTABLE_PATH=/path/to/chrome node scripts/check-api-default-print.mjs`.
That script starts and stops its own fixture server on port 4397; CI also runs it.

Additional browser/Node pixel parity and authenticated API comparisons are
documented in [label-rendering/README.md](label-rendering/README.md).
Generated evidence is optional and must stay outside version control.
