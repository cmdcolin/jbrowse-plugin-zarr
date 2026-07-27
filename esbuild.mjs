import fs from 'node:fs'
import http from 'node:http'
import * as esbuild from 'esbuild'
import { globalExternals } from '@fal-works/esbuild-plugin-global-externals'
import JBrowseReExports from '@jbrowse/core/ReExports/list'
import prettyBytes from 'pretty-bytes'

const isWatch = process.argv.includes('--watch')
const PORT = process.env.PORT ? +process.env.PORT : 9000

function createGlobalMap(jbrowseGlobals) {
  const globalMap = {}
  for (const global of jbrowseGlobals) {
    globalMap[global] = {
      varName: `JBrowseExports["${global}"]`,
      type: 'cjs',
    }
  }
  globalMap['@jbrowse/mobx-state-tree'] = {
    varName: `JBrowseExports["mobx-state-tree"]`,
    type: 'cjs',
  }
  return globalMap
}

const rebuildLogPlugin = {
  name: 'rebuild-log',
  setup({ onStart, onEnd }) {
    let time
    onStart(() => {
      time = Date.now()
    })
    onEnd(({ metafile, errors, warnings }) => {
      console.log(
        `Built in ${Date.now() - time} ms with ${errors.length} error(s) and ${warnings.length} warning(s)}`,
      )
      if (metafile) {
        for (const [file, metadata] of Object.entries(metafile.outputs)) {
          console.log(`Wrote ${prettyBytes(metadata.bytes)} to ${file}`)
        }
      }
    })
  },
}

// zarrita's codec registry reaches numcodecs for blosc/lz4/zstd, and esbuild
// pulls all three wasm builds into the bundle even though they are behind
// dynamic imports it never takes: 1.35 MB of the 1.44 MB output, for codecs
// this plugin's stores do not use. A JBrowse plugin is fetched on page load, so
// that cost is paid by every session. Stubbed with a throw naming the codec, so
// a store compressed some other way fails with an explanation instead of
// silently wrong bytes. gzip, zlib, bytes, transpose and crc32c are implemented
// inside zarrita itself and are unaffected.
const stubNumcodecs = {
  name: 'stub-numcodecs',
  setup(build) {
    build.onResolve({ filter: /^numcodecs\// }, args => ({
      path: args.path,
      namespace: 'numcodecs-stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'numcodecs-stub' }, args => ({
      contents: `const name = ${JSON.stringify(args.path.split('/').pop())}
export default {
  fromConfig() {
    throw new Error(
      \`jbrowse-plugin-zarr is built without the \${name} codec; write the store with gzip (see build_signal_zarr.ts)\`,
    )
  },
}`,
      loader: 'js',
    }))
  },
}

const globals = JBrowseReExports
const config = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  globalName: 'JBrowsePluginZarr',
  metafile: true,
  plugins: [
    globalExternals(createGlobalMap(globals)),
    stubNumcodecs,
    rebuildLogPlugin,
  ],
  ...(isWatch
    ? { outfile: 'dist/out.js' }
    : {
        outfile: 'dist/jbrowse-plugin-zarr.umd.production.min.js',
        sourcemap: true,
        minify: true,
      }),
}

if (isWatch) {
  const ctx = await esbuild.context(config)
  const internalPort = PORT + 400
  const { hosts } = await ctx.serve({ servedir: '.', port: internalPort })

  http
    .createServer((req, res) => {
      const proxyReq = http.request(
        {
          hostname: hosts[0],
          port: internalPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        proxyRes => {
          res.writeHead(proxyRes.statusCode, {
            ...proxyRes.headers,
            'Access-Control-Allow-Origin': '*',
          })
          proxyRes.pipe(res, { end: true })
        },
      )
      req.pipe(proxyReq, { end: true })
    })
    .listen(PORT)

  console.log(`Serving at http://${hosts[0]}:${PORT}`)
  await ctx.watch()
  console.log('Watching files...')
} else {
  const result = await esbuild.build(config)
  fs.writeFileSync('meta.json', JSON.stringify(result.metafile))
}
