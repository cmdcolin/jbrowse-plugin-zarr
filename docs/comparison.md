# Comparison

Numbers for the first two sections are in [benchmarks](benchmarks.md).

## Multi-column bedGraph

Most of this store's gain over BigWigs comes from putting every sample in one
file, and a Tabix-indexed bedGraph with one value column per sample does the
same. JBrowse reads it with the built-in `BedGraphTabixAdapter`, so it needs no
plugin.

- Choose the bedGraph for binned or slowly changing data viewed at a locus: it
  is simpler, smaller, and needs no plugin.
- Choose the store for per-base signal, for whole-chromosome or genome views of a
  large cohort, or when min and max summaries matter. A bedGraph has one bin
  size, so a zoomed-out view returns every row.

## One BigWig per sample

BigWig is the right default for a handful of tracks. Each file costs three to
four sequential header and index requests before any values arrive, so the cost
grows with sample count instead of with the data shown: 100 samples already
take 600-700 requests a screen. The store keeps BigWig's mean, min and max zoom
summaries.

## figwig

[figwig](https://github.com/jmschrei/figwig) is a multi-track per-base binary
format with Python readers, proposed for IGV in
[igvteam/igv#1896](https://github.com/igvteam/igv/issues/1896). This summary is
from its README, spec and that thread as of November 2026, not from running it.

|                          | figwig                                                                           | this store                                 |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------ |
| Container                | custom binary, Kaitai spec, reference reader in numpy and zlib                   | standard Zarr v3                           |
| Primary use              | analysis and ML: GPU decoding, single-cell, Hi-C, single-molecule                | browser display of many samples            |
| Remote reads             | not in the spec; the IGV HTTP reader is an unmerged prototype                    | HTTP range requests against static hosting |
| Zoom summaries           | mean only, over all bases (not only bases with a value)                          | mean, plus optional min and max per level  |
| Size                     | much smaller: 97 MB against 1.08 GB of BigWigs for 48 count tracks in its README | larger; precision is the main lever        |
| Many samples in one file | tracks in groups, each group decoded separately                                  | all samples in one chunk by default        |

The complaints in that thread, and where this store stands:

- **Missing summary types and no zero-vs-NA:** the store has min and max levels,
  and unmeasured bins are `NaN` and dropped rather than drawn as zero.
- **"Why decompress a thousand tracks to show two":** the same applies to the
  default chunk layout here, which suits a track that draws every sample. A
  sample-grouped chunk layout is described in
  [store format](store-format.md#chunk-layout), but the adapter does not yet read
  only the rows a view needs.
- **Remote access:** a static Zarr store needs no server.

figwig is the better choice when file size or analysis workflows matter most;
this store is the better choice for serving a cohort to JBrowse over HTTP.
