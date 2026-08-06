import { BaseFeatureDataAdapter } from '@jbrowse/core/data_adapters/BaseAdapter'
import { SimpleFeature, updateStatus } from '@jbrowse/core/util'
import { ObservableCreate } from '@jbrowse/core/util/rxjs'

import { parseSignalMatrixMetadata, pickLevel } from './signalMatrixMetadata'
import { openZarrGroup, zarritaP } from '../zarrStore'

import type { SignalMatrixMetadata } from './signalMatrixMetadata'
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
// `mins`/`maxs` are the same shape when the level carries a summary, and absent
// on the finest level, which has nothing below it to summarize.
interface RegionSlab {
  numBins: number
  binSize: number
  // genomic coordinate of the slab's first bin
  start: number
  values: Float32Array
  mins: Float32Array | undefined
  maxs: Float32Array | undefined
  // The region's bin grid, built once on first use and shared by every sample
  // whose row has no gaps. Cached on the slab rather than recomputed per sample
  // because it depends only on the region.
  gridStarts?: Int32Array
  gridEnds?: Int32Array
}

const EMPTY_SLAB: RegionSlab = {
  numBins: 0,
  binSize: 1,
  start: 0,
  values: new Float32Array(0),
  mins: undefined,
  maxs: undefined,
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
  const { numBins, binSize, start, values, mins, maxs } = slab
  const lo = sampleIndex * numBins
  const hi = lo + numBins
  const row = values.subarray(lo, hi)
  const minRow = mins?.subarray(lo, hi)
  const maxRow = maxs?.subarray(lo, hi)
  let count = 0
  for (let i = 0; i < numBins; i++) {
    if (!Number.isNaN(row[i]!)) {
      count++
    }
  }

  // The whole row is measured, which is the ordinary case for a binned store
  // and universal at the coarse levels (a 1Mb bin is empty only where the
  // reference is). Then the bin grid is the region's own, identical for every
  // sample, and the values are already a contiguous run of the slab: hand back
  // one shared grid and three views instead of five fresh arrays per sample.
  //
  // This is what decides whether a cohort renders at all. The interface is one
  // RawFeatureArrays per sample PER REGION, so a 24-contig view of 2504 samples
  // asks for 60,096 of them; copying meant ~300,000 typed arrays for a frame
  // holding 31 MB of actual values, and the tab died before it drew. Sharing is
  // safe because the consumer copies into its own buffers
  // (processFeaturesFromArrays) and the transferable collector dedupes the
  // buffers, so 2504 views of one slab transfer once rather than 2504 times.
  if (count === numBins) {
    let { gridStarts, gridEnds } = slab
    if (!gridStarts || !gridEnds) {
      gridStarts = new Int32Array(numBins)
      gridEnds = new Int32Array(numBins)
      for (let i = 0; i < numBins; i++) {
        gridStarts[i] = start + i * binSize
        gridEnds[i] = start + (i + 1) * binSize
      }
      slab.gridStarts = gridStarts
      slab.gridEnds = gridEnds
    }
    return {
      starts: gridStarts,
      ends: gridEnds,
      scores: row,
      minScores: minRow,
      maxScores: maxRow,
      count,
    }
  }

  const starts = new Int32Array(count)
  const ends = new Int32Array(count)
  const scores = new Float32Array(count)
  // Allocated only on a summary level, so a base-resolution read still transfers
  // three arrays rather than five.
  const minScores = minRow ? new Float32Array(count) : undefined
  const maxScores = maxRow ? new Float32Array(count) : undefined
  let out = 0
  for (let i = 0; i < numBins; i++) {
    const score = row[i]!
    if (!Number.isNaN(score)) {
      starts[out] = start + i * binSize
      ends[out] = start + (i + 1) * binSize
      scores[out] = score
      // The converter writes all three from the same set of finer bins, so a
      // NaN here would mean a torn store; fall back to the mean rather than
      // emit a NaN the renderer would carry into its scale.
      if (minScores && maxScores) {
        const min = minRow![i]!
        const max = maxRow![i]!
        minScores[out] = Number.isNaN(min) ? score : min
        maxScores[out] = Number.isNaN(max) ? score : max
      }
      out++
    }
  }
  return { starts, ends, scores, minScores, maxScores, count }
}

// Checked rather than trusted, because the failure is silent otherwise: a level
// with fewer rows than the metadata claims makes the last samples' `subarray`
// run off the end, and `Number.isNaN(undefined)` is false, so those rows come
// back as full-length runs of NaN-scored features instead of an error.
async function openLevelArray(
  group: ZarrGroup<FetchStore>,
  path: string,
  numSamples: number,
) {
  const zarr = await zarritaP
  const array = await zarr.open.v3(group.resolve(path), { kind: 'array' })
  const { shape } = array
  if (shape.length !== 2 || shape[0] !== numSamples) {
    throw new Error(
      `signal matrix level "${path}" is shaped [${shape.join(', ')}], expected [${numSamples}, bins] to match the ${numSamples} samples in the store metadata`,
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

  // One open per array for the life of the adapter: opening an array is its own
  // metadata read, and the level is re-picked on every navigation. Keyed by
  // path rather than by level so a level's mean/min/max are three cache entries
  // and the summary pair is only ever opened on a level that declares it.
  private async openArray(path: string, opts?: BaseOptions) {
    const { group, arrays, meta } = await this.setup(opts)
    let arrayP = arrays.get(path)
    if (!arrayP) {
      // The rejection is not kept. A failed open is usually a transient fetch,
      // and the level is re-picked on every navigation, so caching it would
      // leave that zoom level broken for the life of the adapter with no way
      // back short of reloading the page.
      arrayP = openLevelArray(group, path, meta.samples.length).catch(
        (e: unknown) => {
          arrays.delete(path)
          throw e
        },
      )
      arrays.set(path, arrayP)
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
    const selection = [
      null,
      zarr.slice(span.binOffset + first, span.binOffset + last),
    ]
    const read = async (path: string) => {
      const array = await this.openArray(path, opts)
      const { data } = await zarr.get(array, selection)
      if (!(data instanceof Float32Array)) {
        throw new Error(
          `signal matrix level "${path}" must be float32, got ${array.dtype}`,
        )
      }
      return data
    }
    // In parallel and not sequentially: the three arrays are separate objects
    // in the store, so a summary level costs three round trips rather than one
    // if they wait on each other, which is the whole cost this format exists to
    // avoid. The finest level has no pair and stays a single read.
    const { minPath, maxPath } = level
    const [values, mins, maxs] = await Promise.all([
      read(level.path),
      minPath && maxPath ? read(minPath) : undefined,
      minPath && maxPath ? read(maxPath) : undefined,
    ])
    return {
      numBins: last - first,
      binSize,
      start: span.start + first * binSize,
      values,
      mins,
      maxs,
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
