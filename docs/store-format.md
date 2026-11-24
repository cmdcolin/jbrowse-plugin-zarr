# Store format

Write one with
[`build_signal_zarr.ts`](https://github.com/GMOD/jbrowse-components/blob/main/scripts/build_signal_zarr.ts),
which packs a list of BigWigs into this layout.

A Zarr v3 group whose root attributes carry a `jbrowse_signal_matrix` object,
plus one `float32` array per resolution level:

```json
{
  "jbrowse_signal_matrix": {
    "version": 2,
    "samples": [{ "name": "HG00551", "group": "PUR" }],
    "decimals": 2,
    "levels": [
      {
        "path": "bin1000",
        "binSize": 1000,
        "refs": {
          "chr17": { "start": 35000000, "binOffset": 0, "numBins": 2500 }
        }
      },
      {
        "path": "bin10000",
        "binSize": 10000,
        "minPath": "bin10000_min",
        "maxPath": "bin10000_max",
        "refs": {
          "chr17": { "start": 35000000, "binOffset": 0, "numBins": 250 }
        }
      }
    ]
  }
}
```

- Each level array is shaped `[samples, bins]`, C order, with every refName laid
  end to end on the bin axis at its own `binOffset`.
- `start` is the genomic coordinate of that refName's first bin, so a store can
  cover one window of one chromosome rather than a whole genome.
- Unmeasured bins are the array's `NaN` fill value and are dropped rather than
  drawn as zero.
- Sample entries may carry a `color` and other text attributes, which the
  display uses to color, group and filter rows.
- The adapter reads the coarsest level whose bins are still no wider than a
  screen pixel.

## Chunk layout

Chunk each level with the whole sample axis inside one chunk,
`[all samples, 256 bins]` or thereabouts. This is the opposite of the natural
per-sample layout, and it is what the format buys: split the samples across
chunks and a screenful costs a read per sample again.

The cost is that a view reads every sample's bins even if only a few rows are
shown. The track draws every sample, so this is the intended case. For a large
collection where people show a few samples, chunk `[k samples, 256 bins]` with
related samples together. The adapter reads whatever the chunk shape is, but it
still requests every sample's rows, so that layout would only add requests
until the adapter fetches just the selected rows.

## Summary levels

A level may name two sibling arrays holding the min and max of the finer bins
each of its bins averages, the same thing a BigWig zoom record carries beside
its mean. They are the same shape and chunking as the level itself.

- `minPath` and `maxPath` are optional and always travel together. One without
  the other is rejected, because the display would draw a whisker against the
  mean on the other side and it would read as real asymmetry in the data.
- The finest level has neither: it has nothing below it to summarize.
- Their presence is the feature test, not `version`. A store written before v2
  has none, and a reader that predates them opens `path` and behaves as before.
- A view at a summary level reads all three arrays whatever it draws, as a
  BigWig ships its zoom record whole, so changing the display's `mark.extent`
  (`min-max`) or `encoding.y.field` (`minScore` or `maxScore`) redraws without a
  refetch.
- Without them a zoomed-out view can only show a mean, and anything narrower
  than a coarse bin averages back into the baseline at exactly the zoom someone
  would be scanning for it.
- The min and max are over the store's own finer bins, not over whatever the
  input was. If the finest level is itself an aggregate of something finer, the
  whiskers describe the store, not the source.

## Ideas not done yet

None of these is implemented. They are things the Zarr v3 format already
supports, so a store written this way would not need a new format.

- **Sharding.** The sharding codec packs many inner chunks into one object with
  an index at its end, and a reader fetches an inner chunk by range request. A
  large store then has thousands of files instead of millions, which matters on
  object stores and for copying a store around, while a screen still reads the
  same few inner chunks. zarrita, which this plugin uses, implements the codec.
  What is untested here is how it behaves at this layout's chunk sizes and
  against the hosts people serve from.
- **Sample-grouped chunks with row-only reads.** Chunk `[k samples, 256 bins]`
  and have the adapter request only the rows the display asks for (it already
  receives the wanted sample names). This is the answer for a hub with thousands
  of samples where people show a few. Sharding fits here: one shard per bin range
  holding an inner chunk per sample group keeps one object per region.

## Size

Two knobs, both read-side transparent, so neither needs a reader to know:

- **`chunk-bins`** trades requests against overfetch, not total bytes: a view
  needs the bins it needs. 256 leaves under 20% edge overfetch on a typical
  view; going much smaller multiplies requests to save very little.
- **Stored precision** is usually the bigger lever. gzip on this layout is
  mostly matching repeated values rather than modelling a distribution, so the
  number of distinct values dominates. Quantizing copy number to 0.01 roughly
  halves a store; it does nothing for genuinely continuous data. Record what was
  used in `decimals`, which is provenance only since the values arrive already
  rounded.

The coarse levels are not the cheap ones. Averaging manufactures distinct values
and destroys the repetition gzip was feeding on, so a level with a third of the
bins is not a third of the bytes. Measure before assuming.

The store is not the smallest option; see [benchmarks](benchmarks.md#size-on-disk).

## Codecs

This build ships zarrita's own codecs (`bytes`, `gzip`, `zlib`, `transpose`,
`crc32c`) and stubs the numcodecs ones (`blosc`, `lz4`, `zstd`), which are
1.35 MB of wasm against a 52 KB plugin. A store compressed with one of those
fails with a message naming the codec rather than silently misreading. Write
stores with gzip.

That costs little. On a 2504-sample copy-number chunk, gzip-9 gets 9.9x and
zstd-9 gets 11.4x, so the wasm buys 13%. A byte-shuffle filter ahead of either
makes it worse by 73%: shuffle helps floats that vary smoothly in their
mantissa, and this layout's wins come from long runs of identical values that
shuffle splits across four distant regions of the buffer. Reducing stored
precision beats every codec choice here, and costs no bytes on the wire to
support.
