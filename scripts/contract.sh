#!/usr/bin/env bash
# The gateway's REST contract, as the backend releases it: never a copy of the backend's spec file, always the release
# that api/contract.json pins (repository, version, digest), read anonymously from the registry.
#
#   contract.sh generate  writes gen/api.d.ts (openapi-typescript) from the pinned release;
#   contract.sh check     generates into a scratch folder and fails, printing the diff, when gen/api.d.ts differs;
#                         nothing of the working tree is written.
#
# Before anything is generated, the release must be what the pin says and signed by whom the pin cannot choose:
#   - the manifest fetched by digest hashes to that digest, is a contract release (its artifact type, one OpenAPI
#     layer) and names the pinned version; the tag of that version points at the same digest, so a pin whose version
#     and digest disagree fails instead of generating from either;
#   - cosign verifies a keyless signature of repository@digest by the identity of release source backend (issuer and
#     subject from the table of release sources of the backend at .backend-commit, the table Kyverno and every
#     verifier read): a contract pushed by anyone else, or signed by another workflow, fails;
#   - the layer fetched hashes to the digest the manifest names.
# Any failure leaves gen/ untouched. Runs from the Makefile, after the checkout of .backend/ (scripts/backend.sh
# checkout) and with Node and pnpm of this repository first on PATH; needs docker (the pinned ORAS, and cosign unless
# one is on PATH), jq and the network.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
[ -f "$root/.backend/deploy/ci/common.sh" ] || {
  echo "FAIL  .backend/ has no backend scripts: run scripts/backend.sh checkout first" >&2
  exit 1
}
export SVP_CODE_ROOT=$root
# shellcheck source=/dev/null # the backend's deploy/ci/common.sh at .backend-commit
. "$root/.backend/deploy/ci/common.sh"

artifact_type=application/vnd.anhnvcoder.svp.api-contract.v1
media_type=application/vnd.oai.openapi
pin=$root/api/contract.json
out=$root/gen/api.d.ts

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# oras_ ARGS...: the ORAS the backend's Makefile pins, as the calling user, anonymous, seeing $work as /work.
oras_() {
  local image
  image=$(tool_image ORAS_IMAGE) || return 1
  docker_ run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$work:/work" -w /work "$image" "$@"
}

sha256_of() { echo "sha256:$(shasum -a 256 "$1" | cut -d' ' -f1)"; }

# fetch_contract: the verified spec of the pinned release in $work/openapi.yaml.
fetch_contract() {
  local repository version digest prefix tagged layer
  # The key order is fixed too: Renovate's regex manager reads the three keys in this order, so a reordered pin would
  # still pass here while Renovate silently stopped tracking the contract.
  jq -e 'type == "object" and (keys_unsorted == ["repository", "version", "digest"]) and all(.[]; type == "string")' "$pin" \
    >/dev/null 2>&1 || fail "api/contract.json must hold exactly repository, version and digest, in that order, each a string"
  repository=$(jq -r .repository "$pin")
  version=$(jq -r .version "$pin")
  digest=$(jq -r .digest "$pin")
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "version of api/contract.json must be X.Y.Z, not '$version'"
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail "digest of api/contract.json must be sha256:<64 hex>, not '$digest'"
  sign_identity backend
  prefix=$(release_source backend | jq -r .imagePrefix) || exit 1
  [[ $repository == "$prefix"* && $repository =~ ^[a-z0-9./_-]+$ ]] ||
    fail "repository of api/contract.json must be a repository under $prefix, the prefix of the backend's releases, not '$repository'"

  oras_ manifest fetch --output /work/manifest.json "$repository@$digest" >/dev/null ||
    fail "fetch the manifest of $repository@$digest"
  [ "$(sha256_of "$work/manifest.json")" = "$digest" ] || fail "the manifest of $repository@$digest does not hash to $digest"
  layer=$(jq -re --arg type "$artifact_type" --arg media "$media_type" --arg v "$version" '
    select(.artifactType == $type and (.layers | length) == 1 and .layers[0].mediaType == $media
      and .annotations["org.opencontainers.image.version"] == $v)
    | .layers[0].digest' "$work/manifest.json" 2>/dev/null) ||
    fail "$repository@$digest is not the contract release $version (artifact type, one OpenAPI layer, version)"
  [[ $layer =~ ^sha256:[0-9a-f]{64}$ ]] || fail "the layer of $repository@$digest has no sha256 digest"
  tagged=$(oras_ resolve "$repository:$version") || fail "resolve $repository:$version"
  [ "$tagged" = "$digest" ] ||
    fail "$repository:$version is $tagged, not the digest api/contract.json pins ($digest): pin version and digest of one release"

  cosign_ verify --certificate-oidc-issuer "$sign_issuer" --certificate-identity "$sign_subject" \
    "$repository@$digest" >/dev/null ||
    fail "$repository@$digest carries no valid signature of $sign_subject"
  echo "ok    $repository:$version ($digest) signed by $sign_subject"

  oras_ blob fetch --output /work/openapi.yaml "$repository@$layer" >/dev/null || fail "fetch the spec of $repository:$version"
  [ "$(sha256_of "$work/openapi.yaml")" = "$layer" ] || fail "the spec fetched does not hash to $layer"
}

types_from_contract() {
  pnpm --silent exec openapi-typescript "$work/openapi.yaml" --output "$work/api.d.ts" >/dev/null ||
    fail "openapi-typescript on the contract"
}

case ${1:-} in
generate)
  fetch_contract
  types_from_contract
  mkdir -p "$root/gen"
  cp "$work/api.d.ts" "$out"
  echo "ok    gen/api.d.ts written from the contract"
  ;;
check)
  fetch_contract
  types_from_contract
  if diff -q "$out" "$work/api.d.ts" >/dev/null 2>&1; then
    echo "ok    gen/api.d.ts is up to date with the contract"
    exit 0
  fi
  echo "FAIL  make generate changes gen/api.d.ts (run it and commit the result):" >&2
  diff -u "$out" "$work/api.d.ts" || true
  exit 1
  ;;
*) fail "usage: contract.sh generate|check" ;;
esac
