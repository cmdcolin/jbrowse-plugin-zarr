import { BaseFeatureDataAdapter } from '@jbrowse/core/data_adapters/BaseAdapter'
import { SimpleFeature, isUriLocation, updateStatus } from '@jbrowse/core/util'
import { getFetcher, resolveUriLocation } from '@jbrowse/core/util/io'
import { ObservableCreate } from '@jbrowse/core/util/rxjs'

import { parseSignalMatrixMetadata, pickLevel } from './signalMatrixMetadata'

import type {
  SignalMatrixLevel,
  SignalMatrixMetadata,
} from './signalMatrixMetadata'
import type { BaseOptions } from '@jbrowse/core/data_adapters/BaseAdapter'
import type { Feature, Region } from '@jbrowse/core/util'
import type { Observable } from 'rxjs'
import type {
  Array as ZarrArray,
  DataType,
  FetchStore,
  Group as ZarrGroup,
} from 'zarrita'

// The shape @jbrowse/plugin-wiggle's multi-source RPC executor expects back.
// Declared here rather than imported: that interface is duck-typed on purpose
// (adr-021), so this plugin has no build-time dependency on the wiggle plugin.
export interface RawFeatureArrays {
  starts: Int32Array
  ends: Int32Array
  scores: Float32Array
  minScores: Float32Array | undefined
  maxScores: Float32Array | undefined
  count: number
}

interface WiggleOptions extends BaseOptions {
  bpPerPx?: number
  resolution?: number
  sources?: { name: string }[]
}

// One region's slab of the matrix: every sample's scores over the same bins, in
// C order, so sample i is `values.subarray(i * numBins, (i + 1) * numBins)`.
interface RegionSlab {
  numBins: number
  binSize: number
  // genomic coordinate of the slab's first bin
  start: number
  values: Float32Array
}

const EMPTY_SLAB: RegionSlab = {
  numBins: 0,
  binSize: 1,
  start: 0,
  values: new Float32Array(0),
}

const EMPTY_RAW: RawFeatureArrays = {
  starts: new Int32Array(0),
  ends: new Int32Array(0),
  scores: new Float32Array(0),
  minScores: undefined,
  maxScores: undefined,
  count: 0,
}

// A bin the converter never wrote (no k-mers, a gap, or outside the store's
// covered window) comes back as the array's NaN fill value. Dropping those keeps
// an unmeasured region visibly empty rather than drawing it as zero coverage.
function slabToRaw(slab: RegionSlab, sampleIndex: number): RawFeatureArrays {
  const { numBins, binSize, start, values } = slab
  const row = values.subarray(
    sampleIndex * numBins,
    (sampleIndex + 1) * numBins,
  )
  let count = 0
  for (let i = 0; i < numBins; i++) {
    if (!Number.isNaN(row[i]!)) {
      count++
    }
  }
  const starts = new Int32Array(count)
  const ends = new Int32Array(count)
  const scores = new Float32Array(count)
  let out = 0
  for (let i = 0; i < numBins; i++) {
    const score = row[i]!
    if (!Number.isNaN(score)) {
      starts[out] = start + i * binSize
      ends[out] = start + (i + 1) * binSize
      scores[out] = score
      out++
    }
  }
  return {
    starts,
    ends,
    scores,
    minScores: undefined,
    maxScores: undefined,
    count,
  }
}

// A samples-by-bins quantitative matrix in a Zarr v3 store: one chunk holds
// every sample over a span of bins, so a screenful of a 2500-sample cohort is a
// couple of range requests instead of the 3-4 sequential index reads per file
// that a BigWig-per-sample track pays. The store's own attributes carry the
// sample list, bin size and resolution levels — see signalMatrixMetadata.ts.
export default class MultiWiggleZarrAdapter extends BaseFeatureDataAdapter {
  public static capabilities = ['hasResolution']

  private setupP?: Promise<{
    meta: SignalMatrixMetadata
    group: ZarrGroup<FetchStore>
    arrays: Map<string, Promise<ZarrArray<DataType, FetchStore>>>
  }>

  private async setupPre(opts?: BaseOptions) {
    const { statusCallback = () => {} } = opts ?? {}
    const zarr = await import('zarrita')
    const conf = this.getConf('zarrLocation')
    if (!isUriLocation(conf)) {
      throw new Error(
        'MultiWiggleZarrAdapter needs a URI: a Zarr store is a directory of chunk files, which only an HTTP(S) location can serve',
      )
    }
    const location = resolveUriLocation(conf)
    const fetcher = getFetcher(location, this.pluginManager)
    const store = new zarr.FetchStore(location.uri.replace(/\/+$/, ''), {
      fetch: request => fetcher(request),
    })
    const group = await updateStatus(
      'Downloading zarr metadata',
      statusCallback,
      // v3 explicitly, not the auto-detecting `open`: that probes for v2
      // metadata first, which is two 404 round trips before anything is read.
      // Request count is the whole reason this format exists.
      () => zarr.open.v3(store, { kind: 'group' }),
    )
    return {
      group,
      meta: parseSignalMatrixMetadata(group.attrs),
      arrays: new Map<string, Promise<ZarrArray<DataType, FetchStore>>>(),
    }
  }

  async setup(opts?: BaseOptions) {
    this.setupP ??= this.setupPre(opts).catch((e: unknown) => {
      this.setupP = undefined
      throw e
    })
    return this.setupP
  }

  // One open per level for the life of the adapter: opening an array is its own
  // metadata read, and the level is re-picked on every navigation.
  private async openLevel(level: SignalMatrixLevel, opts?: BaseOptions) {
    const { group, arrays } = await this.setup(opts)
    let arrayP = arrays.get(level.path)
    if (!arrayP) {
      const zarr = await import('zarrita')
      arrayP = zarr.open.v3(group.resolve(level.path), { kind: 'array' })
      arrays.set(level.path, arrayP)
    }
    return arrayP
  }

  public async getRefNames(opts?: BaseOptions) {
    const { meta } = await this.setup(opts)
    return [...new Set(meta.levels.flatMap(l => Object.keys(l.refs)))]
  }

  private async fetchRegionSlab(
    region: Region,
    opts: WiggleOptions = {},
  ): Promise<RegionSlab> {
    const { bpPerPx = 0, resolution = 1 } = opts
    const { meta } = await this.setup(opts)
    const level = pickLevel(meta.levels, bpPerPx / resolution)
    const span = level.refs[region.refName]
    if (!span) {
      return EMPTY_SLAB
    }
    const { binSize } = level
    const first = Math.max(0, Math.floor((region.start - span.start) / binSize))
    const last = Math.min(
      span.numBins,
      Math.ceil((region.end - span.start) / binSize),
    )
    if (last <= first) {
      return EMPTY_SLAB
    }
    const zarr = await import('zarrita')
    const array = await this.openLevel(level, opts)
    const chunk = await zarr.get(array, [
      null,
      zarr.slice(span.binOffset + first, span.binOffset + last),
    ])
    const values = chunk.data
    if (!(values instanceof Float32Array)) {
      throw new Error(
        `signal matrix level "${level.path}" must be float32, got ${array.dtype}`,
      )
    }
    return {
      numBins: last - first,
      binSize,
      start: span.start + first * binSize,
      values,
    }
  }

  public async getMultiSourceFeatureArraysMulti(
    regions: Region[],
    opts: WiggleOptions = {},
  ): Promise<{ source: string; raws: RawFeatureArrays[] }[]> {
    const { meta } = await this.setup(opts)
    const wanted = opts.sources?.length
      ? new Set(opts.sources.map(s => s.name))
      : undefined
    const slabs = await updateStatus(
      'Downloading signal matrix',
      opts.statusCallback ?? (() => {}),
      () =>
        Promise.all(regions.map(region => this.fetchRegionSlab(region, opts))),
    )
    return meta.samples
      .map((sample, sampleIndex) => ({ sample, sampleIndex }))
      .filter(({ sample }) => !wanted || wanted.has(sample.name))
      .map(({ sample, sampleIndex }) => ({
        source: sample.name,
        raws: slabs.map(slab =>
          slab.numBins ? slabToRaw(slab, sampleIndex) : EMPTY_RAW,
        ),
      }))
  }

  public async getSources(_regions: Region[]) {
    const { meta } = await this.setup()
    return meta.samples.map(sample => ({ ...sample, source: sample.name }))
  }

  public getFeatures(
    region: Region,
    opts: WiggleOptions = {},
  ): Observable<Feature> {
    return ObservableCreate<Feature>(async observer => {
      const { meta } = await this.setup(opts)
      const slab = await this.fetchRegionSlab(region, opts)
      const { refName } = region
      for (const [sampleIndex, sample] of meta.samples.entries()) {
        const raw = slabToRaw(slab, sampleIndex)
        for (let i = 0; i < raw.count; i++) {
          observer.next(
            new SimpleFeature({
              uniqueId: `${sample.name}-${raw.starts[i]}`,
              refName,
              start: raw.starts[i]!,
              end: raw.ends[i]!,
              score: raw.scores[i]!,
              source: sample.name,
            }),
          )
        }
      }
      observer.complete()
    }, opts.stopToken)
  }
}
