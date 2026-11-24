# jbrowse-plugin-zarr

Reads multi-sample quantitative signal from a [Zarr v3](https://zarr.dev/) store
into a JBrowse 2
[`MultiQuantitativeTrack`](https://jbrowse.org/jb2/docs/user_guides/multiquantitative_track).
It reads stores written for it, described by a `jbrowse_signal_matrix` metadata
object, not Zarr in general.

One BigWig per sample costs three to four sequential requests per sample, so a
2,500-sample screen is thousands of requests. Here every sample sits in one
array, so a screen is a handful of chunk reads straight off static hosting, with
no tile server.

- Resolution levels, with optional min and max beside the mean, so narrow
  features survive zooming out
- Unmeasured bins stay empty rather than drawing as zero
- Sample names, colors and groups come from the store
- Works on any host that answers range requests

## Install

Needs JBrowse 5. Install it from the
[plugin store](https://jbrowse.org/jb2/docs/user_guides/plugin_store), or name
it in a config by its store name, which resolves to the newest release the host
supports (see
[configuring plugins](https://jbrowse.org/jb2/docs/config_guides/plugins)):

```json
{
  "plugins": [{ "storePlugin": "Zarr" }],
  "tracks": [
    {
      "type": "MultiQuantitativeTrack",
      "trackId": "cohort_signal",
      "name": "Cohort signal",
      "assemblyNames": ["hg38"],
      "adapter": {
        "type": "MultiWiggleZarrAdapter",
        "uri": "https://example.com/cohort.zarr"
      },
      "displayDefaults": { "defaultRendering": "multirowdensity" }
    }
  ]
}
```

The adapter config is the store's location and nothing else. Sample names, bin
size and resolution levels come from the store's own metadata.

## Docs

- [Store format](docs/store-format.md): metadata, chunk layout, summary levels,
  size, codecs, and ideas not done yet such as sharding
- [Benchmarks](docs/benchmarks.md): a worked example on the 1000 Genomes panel,
  and requests, bytes and time against BigWigs and a bedGraph
- [Comparison](docs/comparison.md): when to use a bedGraph, BigWigs or figwig
  instead
- [Development](docs/development.md): building, testing and releasing
