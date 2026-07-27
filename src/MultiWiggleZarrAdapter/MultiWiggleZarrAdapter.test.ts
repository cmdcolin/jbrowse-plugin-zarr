import { gzipSync } from 'zlib'

import MultiWiggleZarrAdapter from './MultiWiggleZarrAdapter'
import configSchema from './configSchema'

// A three-sample, two-level store built in memory and served through the fetch
// mock, so the test exercises the real zarrita read path (v3 metadata, gzip
// codec, chunk grid) rather than a stub of it. Written the same way
// scripts/build_signal_zarr.ts writes one — if the two disagree, this fails.
const SAMPLES = ['s1', 's2', 's3']
const NUM_BINS = 6
const CHUNK_BINS = 4

// bin i of sample j = j * 10 + i, except s2's bin 3, which is unmeasured
const BASE_VALUES = Float32Array.from(
  { length: SAMPLES.length * NUM_BINS },
  (_, i) => {
    const sample = Math.floor(i / NUM_BINS)
    const bin = i % NUM_BINS
    return sample === 1 && bin === 3 ? Number.NaN : sample * 10 + bin
  },
)

function arrayMetadata(numBins: number) {
  return {
    zarr_format: 3,
    node_type: 'array',
    shape: [SAMPLES.length, numBins],
    data_type: 'float32',
    chunk_grid: {
      name: 'regular',
      configuration: { chunk_shape: [SAMPLES.length, CHUNK_BINS] },
    },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 'NaN',
    codecs: [
      { name: 'bytes', configuration: { endian: 'little' } },
      { name: 'gzip', configuration: { level: 6 } },
    ],
    attributes: {},
  }
}

function chunkFiles(path: string, values: Float32Array, numBins: number) {
  const files: Record<string, Uint8Array> = {}
  for (let c = 0; c * CHUNK_BINS < numBins; c++) {
    const buf = new Float32Array(SAMPLES.length * CHUNK_BINS).fill(Number.NaN)
    const from = c * CHUNK_BINS
    const width = Math.min(CHUNK_BINS, numBins - from)
    for (let s = 0; s < SAMPLES.length; s++) {
      buf.set(
        values.subarray(s * numBins + from, s * numBins + from + width),
        s * CHUNK_BINS,
      )
    }
    files[`/${path}/c/0/${c}`] = gzipSync(
      new Uint8Array(buf.buffer, 0, buf.byteLength),
    )
  }
  return files
}

const STORE: Record<string, Uint8Array | string> = {
  '/zarr.json': JSON.stringify({
    zarr_format: 3,
    node_type: 'group',
    attributes: {
      jbrowse_signal_matrix: {
        version: 1,
        samples: SAMPLES.map(name => ({ name, group: 'demo' })),
        levels: [
          {
            path: 'bin100',
            binSize: 100,
            refs: { ctgA: { start: 1000, binOffset: 0, numBins: NUM_BINS } },
          },
        ],
      },
    },
  }),
  '/bin100/zarr.json': JSON.stringify(arrayMetadata(NUM_BINS)),
  ...chunkFiles('bin100', BASE_VALUES, NUM_BINS),
}

function makeAdapter() {
  return new MultiWiggleZarrAdapter(
    configSchema.create({ uri: 'http://localhost/test.zarr' }),
  )
}

// Serve STORE over a stubbed global fetch, so the adapter runs its real
// zarrita read path (v3 metadata, gzip codec, chunk grid) against bytes written
// exactly the way scripts/build_signal_zarr.ts writes them.
let fetchCalls = 0
beforeEach(() => {
  fetchCalls = 0
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    fetchCalls++
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : `${input}`
    const key = new URL(url).pathname.replace('/test.zarr', '')
    const body = STORE[key]
    return Promise.resolve(
      body === undefined
        ? new Response(null, { status: 404 })
        : new Response(typeof body === 'string' ? body : body.slice(), {
            status: 200,
          }),
    )
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('reads sample names and refNames from the store metadata', async () => {
  const adapter = makeAdapter()
  expect(await adapter.getRefNames()).toEqual(['ctgA'])
  expect((await adapter.getSources([])).map(s => s.name)).toEqual(SAMPLES)
  expect((await adapter.getSources([]))[0]!.group).toBe('demo')
})

test('returns one array per sample, aligned to the requested region', async () => {
  const adapter = makeAdapter()
  const region = { refName: 'ctgA', start: 1200, end: 1500, assemblyName: 'a' }
  const result = await adapter.getMultiSourceFeatureArraysMulti([region], {
    bpPerPx: 1,
  })
  expect(result.map(r => r.source)).toEqual(SAMPLES)
  const s1 = result[0]!.raws[0]!
  expect([...s1.starts]).toEqual([1200, 1300, 1400])
  expect([...s1.ends]).toEqual([1300, 1400, 1500])
  expect([...s1.scores]).toEqual([2, 3, 4])
})

test('drops unmeasured bins rather than drawing them as zero', async () => {
  const adapter = makeAdapter()
  const region = { refName: 'ctgA', start: 1200, end: 1500, assemblyName: 'a' }
  const [, s2] = await adapter.getMultiSourceFeatureArraysMulti([region], {
    bpPerPx: 1,
  })
  // s2's bin 3 (1300-1400) is NaN in the store, so it is absent here
  expect([...s2!.raws[0]!.starts]).toEqual([1200, 1400])
  expect([...s2!.raws[0]!.scores]).toEqual([12, 14])
})

test('clamps a region that runs past the end of the stored window', async () => {
  const adapter = makeAdapter()
  const region = { refName: 'ctgA', start: 1500, end: 9000, assemblyName: 'a' }
  const [s1] = await adapter.getMultiSourceFeatureArraysMulti([region], {
    bpPerPx: 1,
  })
  expect([...s1!.raws[0]!.starts]).toEqual([1500])
  expect(s1!.raws[0]!.count).toBe(1)
})

test('returns empty arrays for a refName the store does not cover', async () => {
  const adapter = makeAdapter()
  const region = { refName: 'ctgB', start: 0, end: 1000, assemblyName: 'a' }
  const result = await adapter.getMultiSourceFeatureArraysMulti([region], {
    bpPerPx: 1,
  })
  expect(result).toHaveLength(SAMPLES.length)
  expect(result[0]!.raws[0]!.count).toBe(0)
})

test('honors the sources filter without refetching per sample', async () => {
  const adapter = makeAdapter()
  const region = { refName: 'ctgA', start: 1000, end: 1600, assemblyName: 'a' }
  const result = await adapter.getMultiSourceFeatureArraysMulti([region], {
    bpPerPx: 1,
    sources: [{ name: 's3' }],
  })
  expect(result.map(r => r.source)).toEqual(['s3'])
  // group metadata + array metadata + the two chunks covering six bins. The
  // point of the format: three samples cost the same requests as three thousand
  expect(fetchCalls).toBeLessThanOrEqual(4)
})
