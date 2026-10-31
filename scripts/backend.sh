#!/usr/bin/env bash
# The two copies of the backend repository (anhnvcoder/svp-backend) this repository reads, never writes, and
# the backend commit staging runs:
#
#   backend.sh dir       prints the backend whose harness the end-to-end runs, measurements and source map uploads use:
#                        the compose stack and cluster svp it runs, deploy/compose/lib.sh and deploy/k8s/lib.sh (users,
#                        uploads, the reset of the register rate limit), its .env and .k8s/ca.crt. SVP_BACKEND_DIR when
#                        set (CI sets it to the checkout of its step); otherwise <workspace>/backend, where <workspace>
#                        holds the main checkout of this repository (the parent of the folder of git's common directory,
#                        the same from a worktree). Its working tree is read as it is; nothing is cloned, fetched or
#                        switched there. A folder that is no clone of the backend fails, printing the command that makes
#                        one: no other copy is ever read in its place.
#   backend.sh checkout  makes .backend/ (gitignored) a checkout of the backend at the commit of .backend-commit, the one
#                        place that pins it: the scripts of its deploy/ci/ (scan gate, platform adapter), the tools its
#                        Makefile pins by digest and its table of release sources (the identity a contract is signed
#                        with) are read there, the same on a machine and in CI. A checkout already at that commit is
#                        left as it is (CI may check it out itself); another commit is fetched (that one commit only,
#                        anonymously) and checked out detached. Refuses a folder with uncommitted changes or one that is
#                        no clone of the backend instead of overwriting it.
#   backend.sh stg-revision
#                        prints the backend commit staging runs, one full commit SHA and nothing else on stdout: revision
#                        of envs/stg/charts.yaml in the clone of svp-gitops (anhnvcoder/svp-gitops, the deployment
#                        configuration), SVP_GITOPS_DIR when set, otherwise <workspace>/gitops. Its working tree is read
#                        as it is, like the backend's: nothing is cloned, fetched or switched there, and a folder that is
#                        no clone of svp-gitops fails, printing the command that makes one.
#   backend.sh stg-check fails unless the backend of `backend.sh dir` is checked out at that commit and can run the
#                        releases of staging (make up IMAGES=stg there): a backend older than that mode ignores IMAGES and
#                        builds its six services from source, which is not the backend staging runs.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
backend_url=https://github.com/anhnvcoder/svp-backend.git
gitops_url=https://github.com/anhnvcoder/svp-gitops.git

fail() {
  echo "FAIL  $1" >&2
  exit 1
}

# is_clone DIR [REPO]: true when DIR is the top of a git work tree whose remote origin is anhnvcoder/REPO on GitHub,
# by default the backend repository.
is_clone() {
  local top url repo=${2:-svp-backend}
  [ -d "$1" ] || return 1
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) && [ "$top" = "$(cd "$1" && pwd -P)" ] || return 1
  url=$(git -C "$1" remote get-url origin 2>/dev/null) || return 1
  [[ $url =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)anhnvcoder/$repo(\.git)?$ ]]
}

# workspace WHAT VAR: prints the folder that holds the main checkout of this repository, beside the backend and
# svp-gitops: the parent of the folder of git's common directory, the same from a worktree. WHAT and VAR (the variable
# that names a clone instead) are for the message when this is no git checkout.
workspace() {
  local common
  # --path-format=absolute: otherwise git prints the common directory relative to the current directory.
  common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
    fail "$root is not a git checkout, so the workspace that holds $1 is unknown; set $2"
  dirname "$(dirname "$common")"
}

backend_dir() {
  local dir
  if [ -n "${SVP_BACKEND_DIR:-}" ]; then
    dir=$SVP_BACKEND_DIR
    is_clone "$dir" ||
      fail "SVP_BACKEND_DIR=$dir is not a clone of the backend repository: git clone $backend_url '$dir'"
  else
    dir=$(workspace "the backend" SVP_BACKEND_DIR)/backend || exit 1
    is_clone "$dir" ||
      fail "$dir is not a clone of the backend repository, whose stack and scripts this run needs: git clone $backend_url '$dir' (or set SVP_BACKEND_DIR to a clone)"
  fi
  (cd "$dir" && pwd -P)
}

gitops_dir() {
  local dir
  if [ -n "${SVP_GITOPS_DIR:-}" ]; then
    dir=$SVP_GITOPS_DIR
    is_clone "$dir" svp-gitops || fail "SVP_GITOPS_DIR=$dir is not a clone of svp-gitops: git clone $gitops_url '$dir'"
  else
    dir=$(workspace "the clone of svp-gitops" SVP_GITOPS_DIR)/gitops || exit 1
    is_clone "$dir" svp-gitops ||
      fail "$dir is not a clone of svp-gitops, the deployment configuration that says which backend staging runs: git clone $gitops_url '$dir' (or set SVP_GITOPS_DIR to a clone)"
  fi
  (cd "$dir" && pwd -P)
}

stg_revision() {
  local dir revision
  dir=$(gitops_dir) || exit 1
  revision=$(sed -n 's/^revision:[[:space:]]*//p' "$dir/envs/stg/charts.yaml" 2>/dev/null) ||
    fail "read envs/stg/charts.yaml of $dir"
  # Checked before anyone uses it: the commit goes on into a checkout of the backend.
  [[ $revision =~ ^[0-9a-f]{40}$ ]] ||
    fail "envs/stg/charts.yaml of $dir holds no revision of one full commit SHA of the backend"
  echo "staging runs the backend at $revision (svp-gitops at $(git -C "$dir" rev-parse --short=12 HEAD) in $dir)" >&2
  echo "$revision"
}

stg_check() {
  local revision dir head
  revision=$(stg_revision) || exit 1
  dir=$(backend_dir) || exit 1
  head=$(git -C "$dir" rev-parse --verify --quiet HEAD) || head=
  [ "$head" = "$revision" ] ||
    fail "the backend in $dir is at ${head:-no commit}, not at $revision, the commit staging runs: check that commit out in a folder of its own (git -C '$dir' worktree add <folder> $revision) and point SVP_BACKEND_DIR at it"
  # compose_images is where make up reads IMAGES=stg; the commit that brought it brought WEB_FROM=clone and the build of
  # a web client from a clone of this repository with it.
  grep -q '^compose_images()' "$dir/deploy/k8s/lib.sh" 2>/dev/null ||
    fail "the backend at ${revision:0:12}, the commit staging runs, has no make up IMAGES=stg (compose_images of deploy/k8s/lib.sh): no end-to-end run against staging until staging runs a newer backend"
  echo "ok    the backend in $dir is at ${revision:0:12}, the commit staging runs, and runs the releases of staging"
}

backend_checkout() {
  local dir=$root/.backend want head
  # No credential helper and no prompt: the backend is public and read anonymously.
  local git_=(env GIT_TERMINAL_PROMPT=0 git -c credential.helper=)
  want=$(cat "$root/.backend-commit" 2>/dev/null) || fail "read .backend-commit"
  [[ $want =~ ^[0-9a-f]{40}$ ]] || fail ".backend-commit must hold one full commit SHA of the backend, nothing else"
  if [ -e "$dir" ]; then
    is_clone "$dir" || fail "$dir is not a checkout of the backend; remove it (rm -rf .backend) and run again"
    [ -z "$(git -C "$dir" status --porcelain)" ] ||
      fail "$dir has uncommitted changes, which are never overwritten; remove them (or the folder) first"
    head=$(git -C "$dir" rev-parse --verify --quiet HEAD) || head=
    if [ "$head" = "$want" ]; then
      echo "ok    backend scripts at ${want:0:12} in .backend/"
      return
    fi
  else
    git init -q "$dir" || fail "create $dir"
    git -C "$dir" remote add origin "$backend_url" || fail "set the origin of $dir"
  fi
  "${git_[@]}" -C "$dir" fetch -q --depth 1 origin "$want" || fail "fetch ${want:0:12} of $backend_url into $dir"
  git -C "$dir" checkout -q --detach "$want" || fail "check out ${want:0:12} in $dir"
  echo "ok    backend scripts at ${want:0:12} in .backend/"
}

case ${1:-} in
dir) backend_dir ;;
checkout) backend_checkout ;;
stg-revision) stg_revision ;;
stg-check) stg_check ;;
*) fail "usage: backend.sh dir|checkout|stg-revision|stg-check" ;;
esac
