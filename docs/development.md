# Development

```bash
pnpm install
pnpm test          # vitest, adapter round trip against an in-memory store
pnpm start         # esbuild watch, serves dist/out.js on :9000
pnpm build         # dist/jbrowse-plugin-zarr.umd.production.min.js
```

Point a JBrowse config's plugin `url` at `http://localhost:9000/dist/out.js` to
develop against the watch build.

## Release

```bash
pnpm version patch # lint, typecheck, test, build, then push the v* tag
```

The tag publishes to npm from CI by trusted publishing, and the plugin store
takes it from npm at its next update.

`pnpm betabuild` still pushes an unreleased build to
`https://jbrowse.org/demos/zarr/jbrowse-plugin-zarr.umd.production.min.js` for
trying a change in a config before releasing it. It re-downloads the entry point
through CloudFront afterwards and fails if it does not match what was just
built.
