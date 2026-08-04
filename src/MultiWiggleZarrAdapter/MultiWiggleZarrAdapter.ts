import { BaseFeatureDataAdapter } from '@jbrowse/core/data_adapters/BaseAdapter'
import { SimpleFeature, updateStatus } from '@jbrowse/core/util'
import { ObservableCreate } from '@jbrowse/core/util/rxjs'

import { parseSignalMatrixMetadata, pickLevel } from './signalMatrixMetadata'
import { openZarrGroup, zarritaP } from '../zarrStore'

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

// The subtree filter in the clustering sidebar narrows the source list the
// display sends down, so this is a real user-driven filter and not just the
// full list echoed back. `undefined` means "no filter", which is not the same
// as an empty one.
function wantedNames(sources: { name: string }[] | undefined) {
  return sources?.length ? new Set(sources.map(s => s.name)) : undefined
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

// Checked rather than trusted, because the failure is silent otherwise: a level
// with fewer rows than the metadata claims makes the last samples' `subarray`
// run off the end, and `Number.isNaN(undefined)` is false, so those rows come
// back as full-length runs of NaN-scored features instead of an error.
async function openLevelArray(
  group: ZarrGroup<FetchStore>,
  level: SignalMatrixLevel,
  numSamples: number,
) {
  const zarr = await zarritaP
  const array = await zarr.open.v3(group.resolve(level.path), { kind: 'array' })
  const { shape } = array
  if (shape.length !== 2 || shape[0] !== numSamples) {
    throw new Error(
      `signal matrix level "${level.path}" is shaped [${shape.join(', ')}], expected [${numSamples}, bins] to match the ${numSamples} samples in the store metadata`,
    )
  }
  return array
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
    const group = await updateStatus(
      'Downloading zarr metadata',
      statusCallback,
      () =>
        openZarrGroup({
          adapterName: 'MultiWiggleZarrAdapter',
          location: this.getConf('zarrLocation'),
          pluginManager: this.pluginManager,
        }),
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
    const { group, arrays, meta } = await this.setup(opts)
    let arrayP = arrays.get(level.path)
    if (!arrayP) {
      // The rejection is not kept. A failed open is usually a transient fetch,
      // and the level is re-picked on every navigation, so caching it would
      // leave that zoom level broken for the life of the adapter with no way
      // back short of reloading the page.
      arrayP = openLevelArray(group, level, meta.samples.length).catch(
        (e: unknown) => {
          arrays.delete(level.path)
          throw e
        },
      )
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
    const resolutionMultiplier: number = this.getConf('resolutionMultiplier')
    const level = pickLevel(
      meta.levels,
      (bpPerPx / resolution) * resolutionMultiplier,
    )
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
    const zarr = await zarritaP
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
    const wanted = wantedNames(opts.sources)
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

  // The feature-object path, which the multiwiggle render never takes — it uses
  // the typed arrays above. This is what clustering (getScoreMatrix) reads, and
  // it costs one SimpleFeature per sample per bin, so it emits straight off the
  // slab rather than building per-sample typed arrays it would immediately throw
  // away.
  public getFeatures(
    region: Region,
    opts: WiggleOptions = {},
  ): Observable<Feature> {
    return ObservableCreate<Feature>(async observer => {
      const { meta } = await this.setup(opts)
      const wanted = wantedNames(opts.sources)
      const { numBins, binSize, start, values } = await this.fetchRegionSlab(
        region,
        opts,
      )
      const { refName } = region
      for (const [sampleIndex, sample] of meta.samples.entries()) {
        if (wanted && !wanted.has(sample.name)) {
          continue
        }
        const row = values.subarray(
          sampleIndex * numBins,
          (sampleIndex + 1) * numBins,
        )
        for (let i = 0; i < numBins; i++) {
          const score = row[i]!
          if (Number.isNaN(score)) {
            continue
          }
          const featureStart = start + i * binSize
          observer.next(
            new SimpleFeature({
              // refName included: getFeaturesInMultipleRegions concatenates
              // regions, and two of them can hold the same bin coordinate on
              // different contigs.
              uniqueId: `${sample.name}-${refName}-${featureStart}`,
              refName,
              start: featureStart,
              end: featureStart + binSize,
              score,
              source: sample.name,
            }),
          )
        }
      }
      observer.complete()
    }, opts.stopToken)
  }
}
