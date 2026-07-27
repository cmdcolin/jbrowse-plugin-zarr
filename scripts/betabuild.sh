#!/usr/bin/env bash
# Build the plugin and publish it to the beta demo bucket.
#
# Same arrangement as jbrowse-plugin-graphgenomeviewer, and the same two traps
# apply, so they are handled the same way:
#
#   1. uploading a stale dist/ — so this always cleans and rebuilds, and gates
#      on lint, typecheck and tests first, because the artifact is public the
#      moment it lands.
#   2. an upload nobody can see. jbrowse.org sits behind CloudFront, so an
#      object written without Cache-Control keeps being served from the edge
#      long after a successful S3 write. Cache-Control is set explicitly and the
#      entry point is invalidated every time.
#
# This bundle is a single fixed-name UMD file plus its map — nothing here is
# content-hashed — so everything gets the short TTL and everything is
# invalidated. That is why the build below is `build:bundle` and not `build`:
# `build` also runs tsc, which writes .js/.d.ts next to the bundle, and those
# would be uploaded alongside it for no reason.
#
# Finishes by downloading what the CDN actually serves and comparing it to what
# was just built. That comparison is the whole point.
#
# Env overrides: BUCKET, PREFIX, DISTRIBUTION_ID, SKIP_CHECKS=1
set -euo pipefail

cd "$(dirname "$0")/.."

BUCKET="${BUCKET:-jbrowse.org}"
PREFIX="${PREFIX:-demos/zarr}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:-E13LGELJOT4GQO}"
ENTRY="jbrowse-plugin-zarr.umd.production.min.js"
BASE_URL="https://${BUCKET}/${PREFIX}"

echo "==> publishing to s3://${BUCKET}/${PREFIX}/"

if [ "${SKIP_CHECKS:-0}" != "1" ]; then
  echo "==> lint"
  pnpm lint
  # Not optional, and not covered by the unit tests: a bundle that imports a
  # name a host global does not actually export builds and unit-tests clean,
  # then throws the moment a track using the adapter is opened.
  echo "==> typecheck"
  pnpm typecheck
  echo "==> tests"
  pnpm test
fi

echo "==> build"
pnpm clean
NODE_ENV=production node esbuild.mjs

if [ ! -f "dist/${ENTRY}" ]; then
  echo "no dist/${ENTRY} after build" >&2
  exit 1
fi

echo "==> upload"
aws s3 cp dist/ "s3://${BUCKET}/${PREFIX}/" --recursive \
  --cache-control "public, max-age=60"

echo "==> invalidate"
invalidation=$(aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/${PREFIX}/${ENTRY}" "/${PREFIX}/${ENTRY}.map" \
  --query 'Invalidation.Id' --output text)
echo "    $invalidation"

until [ "$(aws cloudfront get-invalidation --distribution-id "$DISTRIBUTION_ID" \
  --id "$invalidation" --query 'Invalidation.Status' --output text)" = "Completed" ]; do
  sleep 10
done

echo "==> verify what the CDN serves matches what was built"
served=$(mktemp)
trap 'rm -f "$served"' EXIT
curl -fsS -o "$served" "${BASE_URL}/${ENTRY}"
local_md5=$(md5sum "dist/${ENTRY}" | cut -d' ' -f1)
served_md5=$(md5sum "$served" | cut -d' ' -f1)
if [ "$local_md5" != "$served_md5" ]; then
  echo "MISMATCH: built $local_md5 but ${BASE_URL}/${ENTRY} serves $served_md5" >&2
  exit 1
fi
echo "    ok, $local_md5"

# The bundle registers itself on a global that the JBrowse plugin loader reads
# back by name. A rename in esbuild.mjs would still build, upload and serve, and
# only fail at load time with "plugin did not define JBrowsePluginZarr".
echo "==> verify the UMD global is present"
grep -q 'JBrowsePluginZarr' "$served" || {
  echo "served bundle does not mention the JBrowsePluginZarr global" >&2
  exit 1
}

echo "==> done: ${BASE_URL}/${ENTRY}"
