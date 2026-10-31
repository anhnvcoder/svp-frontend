# Build, check and test entry point of the web client. `make help` lists the targets.
#
# Two copies of the backend repository (anhnvcoder/svp-backend) serve different ends (scripts/backend.sh):
#   - .backend/, gitignored: the backend at the commit of .backend-commit (make backend-checkout), the one place that
#     pins it. The scan gate and platform adapter of its deploy/ci/, the tools its Makefile pins by digest (trivy, ORAS,
#     cosign) and its table of release sources are read there, the same on a machine and in CI.
#   - SVP_BACKEND_DIR, default <workspace>/backend: the backend whose compose stack or cluster svp the end-to-end runs,
#     measurements and source map uploads talk to, with its deploy/compose/lib.sh, deploy/k8s/lib.sh, .env and
#     .k8s/ca.crt. Its working tree is read as it is.

# Node's major is pinned in .nvmrc and pnpm's exact version in the packageManager field of package.json; every target
# that runs Node checks both before it runs anything and, on a mismatch, prints the command that installs the right
# one. nvm leaves PATH to the shell and its default may be another major, so the newest nvm install of the pinned major
# goes first on PATH; without one (CI's setup-node) PATH is used as it is. Next's anonymous telemetry is off for every
# target.
NODE_MAJOR := $(shell cat .nvmrc 2>/dev/null)
NVM_DIR ?= $(HOME)/.nvm
NODE_BIN := $(shell ls -d $(NVM_DIR)/versions/node/v$(NODE_MAJOR).*/bin 2>/dev/null | sort -V | tail -1)
NODE := export $(if $(NODE_BIN),PATH="$(NODE_BIN):$$PATH") NEXT_TELEMETRY_DISABLED=1 && \
	node_major=$$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null); \
	if [ "$$node_major" != "$(NODE_MAJOR)" ]; then echo "this repository needs Node $(NODE_MAJOR) (.nvmrc), found \
	$$(node --version 2>/dev/null || echo none): nvm install $(NODE_MAJOR)" >&2; exit 1; fi; \
	pnpm_want=$$(node -p 'require("./package.json").packageManager.split("@")[1]') || exit 1; \
	if [ "$$(pnpm --version 2>/dev/null)" != "$$pnpm_want" ]; then echo "this repository needs pnpm $$pnpm_want \
	(packageManager of package.json), found $$(pnpm --version 2>/dev/null || echo none): npm install -g \
	pnpm@$$pnpm_want" >&2; exit 1; fi;

# The backend whose stack or cluster a run talks to (scripts/backend.sh dir), exported to the scripts as
# SVP_BACKEND_DIR; SVP_WEB_DIR names this clone, so the backend's scripts that build or read the web's source (the
# source map upload) take this one.
BACKEND := backend_dir=$$(bash scripts/backend.sh dir) || exit 1; \
	export SVP_BACKEND_DIR="$$backend_dir" SVP_WEB_DIR="$(CURDIR)";

# Local Redis, db 15: the test database of the lab, used by no service or other project, so tests never touch their
# data and never need FLUSHDB.
SVP_TEST_REDIS_URL ?= redis://127.0.0.1:6379/15

.DEFAULT_GOAL := help

.PHONY: help install dev backend-checkout tools stg-revision stg-check generate generate-check check lockfile-scan e2e \
	measure-web measure-upload lighthouse sourcemaps k8s-sourcemaps k8s-e2e

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z0-9_-]+:.*## / { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install the packages exactly as pnpm-lock.yaml pins them
	@$(NODE) pnpm install --frozen-lockfile

# next dev on loopback only, against the gateway of the backend's `make up` and the web's session database (Redis
# db 9). The browser origin is http://localhost:3002, not 127.0.0.1: POST requests from any other origin are refused as
# CSRF.
dev: ## Run the web client in dev mode at http://localhost:3002 against the gateway at 127.0.0.1:8080
	@$(NODE) GATEWAY_URL=http://127.0.0.1:8080 REDIS_URL=redis://127.0.0.1:6379/9 APP_ORIGIN=http://localhost:3002 \
		MEDIA_ORIGIN=http://127.0.0.1:9000 UPLOAD_ORIGIN=http://127.0.0.1:9000 \
		pnpm dev --port 3002 --hostname 127.0.0.1

backend-checkout: ## Check out the backend at the commit of .backend-commit into .backend/ (its CI scripts and pinned tools; fetches only when the commit changed)
	@bash scripts/backend.sh checkout

# The two Go tools CI runs here, the secret scan of the git history and the linter of the workflows, at the versions
# the backend's Makefile pins (.backend/), the one place both are pinned: built with the Go on PATH and installed
# where go install puts them (GOBIN, otherwise $(go env GOPATH)/bin). A version that is not one vX.Y.Z there fails
# before anything is built.
tools: backend-checkout ## Install gitleaks and actionlint, at the versions the backend's Makefile pins, with go install (needs Go)
	@for tool in GITLEAKS_VERSION=github.com/zricethezav/gitleaks/v8 \
		ACTIONLINT_VERSION=github.com/rhysd/actionlint/cmd/actionlint; do \
	  var=$${tool%%=*}; package=$${tool#*=}; \
	  version=$$(sed -n "s/^$$var[[:space:]]*:=[[:space:]]*//p" .backend/Makefile | grep -xE 'v[0-9]+\.[0-9]+\.[0-9]+') || \
	    { echo "$$var is not pinned to one version vX.Y.Z in .backend/Makefile" >&2; exit 1; }; \
	  echo "go install $$package@$$version"; go install "$$package@$$version" || exit 1; \
	done

# Which backend the end-to-end runs against staging use (scripts/backend.sh says how): the commit envs/stg/charts.yaml
# of the clone of svp-gitops names (SVP_GITOPS_DIR, default <workspace>/gitops), and a check that the backend of
# SVP_BACKEND_DIR (default <workspace>/backend) is checked out there and can run the releases of staging.
stg-revision: ## Print the backend commit staging runs (envs/stg/charts.yaml of the clone of svp-gitops), one full SHA on stdout
	@bash scripts/backend.sh stg-revision

stg-check: ## Fail unless the backend (SVP_BACKEND_DIR) is checked out at the commit staging runs and has make up IMAGES=stg
	@bash scripts/backend.sh stg-check

# The API types come from the gateway's contract as the backend released it, pinned in api/contract.json, after its
# digest, version and signature are checked (scripts/contract.sh says what is checked); never from a copy of the spec.
generate: backend-checkout ## Generate gen/api.d.ts from the released contract api/contract.json pins, once its digest and signature check out
	@$(NODE) bash scripts/contract.sh generate

generate-check: backend-checkout ## Fail when make generate would change gen/api.d.ts: print the diff (writes nothing under gen/)
	@$(NODE) bash scripts/contract.sh check

# Bundle budgets on the output of next build, gzip, checked by size-limit with .size-limit.json. Each route has
# two budgets. The first covers what the route adds to Next's
# runtime: the chunks the build's client reference manifest lists for the route's layouts, page and error boundaries
# (the scripts of its HTML), plus the chunks those load lazily (hls.js on the feed and /v/[id]). The second covers the
# whole first load, that set plus the runtime (rootMainFiles of build-manifest.json: React, react-dom, Next's router,
# the same on every route), so a runtime that grows fails the check too. The nomodule polyfill, which current browsers
# skip, is left out of both. Turbopack names chunks by a content hash, so each set is copied to .next/size-limit/<set>/
# first, where the config's globs find it. The copy drops each chunk's last line, the sourceMappingURL comment, as the
# image's build does (Dockerfile): the budgets count the bytes the image serves, debug id included.
define SIZE_CHUNKS
const fs = require("node:fs");
const runtime = JSON.parse(fs.readFileSync(".next/build-manifest.json", "utf8")).rootMainFiles;
function routeChunks(page) {
  globalThis.__RSC_MANIFEST = {};
  require(process.cwd() + "/.next/server/app/" + page + "_client-reference-manifest.js");
  const chunks = new Set(Object.values(globalThis.__RSC_MANIFEST["/" + page].entryJSFiles).flat());
  for (const chunk of chunks) {
    const refs = fs.readFileSync(".next/" + chunk, "utf8").match(/static\/chunks\/[\w-]+\.js/g) ?? [];
    for (const ref of refs) if (!runtime.includes(ref)) chunks.add(ref);
  }
  return [...chunks].filter((chunk) => !runtime.includes(chunk));
}
const sets = {
  runtime,
  feed: routeChunks("(main)/page"),
  login: routeChunks("(auth)/login/page"),
  upload: routeChunks("(main)/upload/page"),
  video: routeChunks("v/[id]/page"),
};
fs.rmSync(".next/size-limit", { recursive: true, force: true });
for (const [name, chunks] of Object.entries(sets)) {
  fs.mkdirSync(".next/size-limit/" + name, { recursive: true });
  for (const chunk of chunks) {
    const served = fs.readFileSync(".next/" + chunk, "utf8").replace(/^\/\/# sourceMappingURL=.*\n?/gm, "");
    fs.writeFileSync(".next/size-limit/" + name + "/" + chunk.split("/").pop(), served);
  }
}
endef
export SIZE_CHUNKS

# The standalone server of next build, the one the image runs, started once and asked for /healthz: a module its
# instrumentation hook loads but the build left out (a require the bundler and the trace cannot follow) passes the
# unit tests and next build, yet makes every route of the image answer 500. On 127.0.0.1 only, at a free port the
# check picks itself; the server gets a fixed environment, not this shell's, whose hosts end in .invalid: /healthz
# reads neither Redis nor the gateway, so nothing is reached. Stopped by its own handle once it answers.
define STANDALONE_BOOT
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
(async () => {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = String(probe.address().port);
  probe.close();
  const server = spawn(process.execPath, ["server.js"], {
    cwd: ".next/standalone",
    env: {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      HOSTNAME: "127.0.0.1",
      PORT: port,
      GATEWAY_URL: "http://gateway.invalid",
      REDIS_URL: "redis://redis.invalid:6379/9",
      APP_ORIGIN: "http://localhost:" + port,
      MEDIA_ORIGIN: "https://media.invalid",
      UPLOAD_ORIGIN: "https://upload.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  server.stdout.on("data", (chunk) => output.push(chunk));
  server.stderr.on("data", (chunk) => output.push(chunk));
  let exit = null;
  const exited = once(server, "exit").then(([code, signal]) => (exit = signal ?? code));
  let status = "no answer within 30 s";
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (exit !== null) {
      status = "none, the server exited (" + exit + ")";
      break;
    }
    try {
      status = (await fetch("http://127.0.0.1:" + port + "/healthz", { signal: AbortSignal.timeout(5000) })).status;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  server.kill();
  await exited;
  if (status === 200) {
    console.log("standalone server: GET /healthz 200");
    return;
  }
  process.stderr.write(Buffer.concat(output));
  console.error("standalone server: GET /healthz " + status);
  process.exitCode = 1;
})();
endef
export STANDALONE_BOOT

check: ## Lint, format check, typecheck, unit tests (Redis db 15), production build, a start of its standalone server and bundle budgets
	@$(NODE) pnpm lint && pnpm format:check && pnpm typecheck && \
		SVP_TEST_REDIS_URL='$(SVP_TEST_REDIS_URL)' pnpm test && pnpm build && \
		node -e "$$STANDALONE_BOOT" && node -e "$$SIZE_CHUNKS" && pnpm size

# Vulnerability gate of the npm dependencies, read from the lockfile: the image shows trivy only the few packages left
# in its node_modules, since the bundler folds the server's dependencies into its chunks. Development dependencies
# count too: they run in CI and build the bundle that ships. The backend's deploy/ci/scan-gate.sh (.backend/) decides
# as for an image, with .trivyignore.yaml of this repository: any CRITICAL left after it fails, fixed upstream or not;
# HIGH and below are only counted. Only the lockfile is mounted (read-only), at pnpm-lock.yaml of the scan root so the
# findings point at the file of the repository. A report with no npm package fails too: a lockfile format trivy no
# longer reads would otherwise pass with nothing scanned. trivy runs from the image the backend's Makefile pins and
# needs the network for its DB; a DB it cannot download fails the target: no scan against a DB of unknown age.
# LOCKFILE (absolute path of a file named pnpm-lock.yaml) scans another lockfile, for a negative check. LOCKFILE_SARIF
# set to an absolute path writes a SARIF report of the HIGH and CRITICAL findings there, before the gate decides, so a
# blocked lockfile still shows on main. SVP_TRIVY_CACHE, when set, keeps the DB in that directory; unset, the DB goes
# to a cache inside the container.
LOCKFILE ?= $(CURDIR)/pnpm-lock.yaml
LOCKFILE_SARIF ?=
lockfile-scan: backend-checkout ## trivy fs on pnpm-lock.yaml, dev dependencies included; fails on any CRITICAL (LOCKFILE_SARIF=<absolute path> writes SARIF)
	@lockfile='$(LOCKFILE)'; \
	[ "$$(basename "$$lockfile")" = pnpm-lock.yaml ] && [ -f "$$lockfile" ] || { echo "LOCKFILE=$$lockfile is not \
	a file named pnpm-lock.yaml" >&2; exit 1; }; \
	lockfile="$$(cd "$$(dirname "$$lockfile")" && pwd)/pnpm-lock.yaml" || exit 1; label=$${lockfile#$(CURDIR)/}; \
	image=$$(sed -n 's/^TRIVY_IMAGE[[:space:]]*:=[[:space:]]*//p' .backend/Makefile); \
	case $$image in *@sha256:*) ;; *) echo "TRIVY_IMAGE is not pinned by digest in .backend/Makefile" >&2; exit 1;; esac; \
	tmp=$$(mktemp -d) || exit 1; trap 'rm -rf "$$tmp"' EXIT; \
	set -- -v "$$lockfile:/scan/pnpm-lock.yaml:ro" -v "$$tmp:/out"; \
	if [ -n "$(SVP_TRIVY_CACHE)" ]; then mkdir -p "$(SVP_TRIVY_CACHE)" || exit 1; \
	  set -- "$$@" -v "$(SVP_TRIVY_CACHE):/cache"; cache=/cache; else cache=/tmp/trivy; fi; \
	set -- "$$@" -v "$(CURDIR)/.trivyignore.yaml:/ignore.yaml:ro"; \
	trivy() { env -u DOCKER_DEFAULT_PLATFORM docker run --rm --user "$$(id -u):$$(id -g)" -e HOME=/tmp "$$@"; }; \
	trivy "$$@" "$$image" fs --scanners vuln --include-dev-deps --list-all-pkgs --format json \
		--output /out/trivy.json --quiet --cache-dir "$$cache" --ignorefile /ignore.yaml /scan || exit 1; \
	packages=$$(jq '[.Results[]? | select(.Type == "pnpm") | .Packages[]?] | length' "$$tmp/trivy.json") || exit 1; \
	echo "$$label: $$packages npm packages scanned"; \
	[ "$$packages" -gt 0 ] || { echo "FAIL  $$label: trivy read no npm package from it" >&2; exit 1; }; \
	if [ -n "$(LOCKFILE_SARIF)" ]; then \
	  trivy "$$@" -v "$$(dirname "$(LOCKFILE_SARIF)"):/sarif" "$$image" convert --format sarif \
		--severity HIGH,CRITICAL --output "/sarif/$$(basename "$(LOCKFILE_SARIF)")" /out/trivy.json || exit 1; fi; \
	SVP_CODE_ROOT='$(CURDIR)' .backend/deploy/ci/scan-gate.sh --fs "$$label" "$$tmp/trivy.json"

# Both need the backend's compose stack (make up there) and the Playwright browsers (pnpm exec playwright install
# chromium webkit). LOCAL LAB ONLY: the seed (e2e/seed.sh) and every Playwright worker (e2e/fixtures.ts) delete the
# gateway's register rate limit keys in Redis db 10, as the backend's smoke run does.
e2e: ## Playwright end-to-end tests on Chromium and WebKit against the backend's compose stack (pnpm e2e)
	@$(NODE) $(BACKEND) pnpm e2e

measure-web: ## Run e2e and print time to first frame after a swipe (p50/p95 per browser) and the memory of container web at rest and after; JSON in test-results/
	@$(NODE) $(BACKEND) bash e2e/measure-web.sh

# Needs the backend's stack, ffmpeg and jq; LOCAL LAB ONLY like e2e (the seed runs first).
measure-upload: ## Upload a ~100 MB video from Chromium through /upload; print time, throughput, page CPU and time to READY; JSON in test-results/
	@$(NODE) $(BACKEND) bash e2e/measure-upload.sh

# Needs the backend's stack and Playwright's Chromium (pnpm exec playwright install chromium); one run per page, so the
# numbers carry noise. LOCAL LAB ONLY like e2e: lighthouse/run.sh registers a fresh user and deletes the gateway's
# register rate limit keys in Redis db 10 first.
lighthouse: ## Lighthouse (mobile, one run per page) of the feed logged in and /v/{id} logged out: LCP/CLS/TBT thresholds, reports in test-results/lighthouse/
	@$(NODE) $(BACKEND) bash lighthouse/run.sh

# Needs the backend's stack with GlitchTip (make up OBS=lgtm there, which writes SENTRY_SOURCEMAPS_TOKEN to its .env);
# the backend's deploy/observability/glitchtip/sourcemaps.sh builds the stage sourcemaps of the image from this
# working tree, which the build cache answers with the maps of the image the stack built.
sourcemaps: ## Upload the source maps of the browser bundle, from the build the backend's stack (make up OBS=lgtm) runs, to its GlitchTip (http://127.0.0.1:8000); checks first that the web serves that build
	@$(NODE) $(BACKEND) bash "$$SVP_BACKEND_DIR/deploy/observability/glitchtip/sourcemaps.sh" compose

# The same for cluster svp of the backend: built with the build id its make k8s-up gave the image, or with
# SOURCEMAPS_DIR read from a folder of chunks and maps made by an earlier build (CI's of the image the GitOps cluster
# runs); either way checked against the chunks https://svp.localhost:8443 serves, uploaded through a port-forward of
# its own on 127.0.0.1:8000, closed at the end.
SOURCEMAPS_DIR ?=
k8s-sourcemaps: ## Upload the source maps of the browser bundle, from the build cluster svp runs (SOURCEMAPS_DIR=<absolute folder> takes that folder's chunks and maps instead of a build), to its GlitchTip; checks first that the web serves that build (port 127.0.0.1:8000 must be free)
	@$(NODE) $(BACKEND) bash "$$SVP_BACKEND_DIR/deploy/observability/glitchtip/sourcemaps.sh" k3d \
		$(if $(SOURCEMAPS_DIR),'$(SOURCEMAPS_DIR)')

# The end-to-end tests against the backend's cluster svp at https://svp.localhost:8443, through e2e/k3d-e2e.sh: it
# checks the backend's .k8s/ca.crt and the cluster, sets SVP_STACK=k3d and the CA for curl and Node, and with
# SVP_E2E_GLITCHTIP=1 also runs e2e/glitchtip.e2e.ts with the read-only token of Secret svp-obs/glitchtip-api and a
# port-forward of its own on 127.0.0.1:8000. SVP_E2E_EVIDENCE as for e2e.
k8s-e2e: ## Playwright end-to-end tests on Chromium and WebKit against cluster svp at https://svp.localhost:8443; SVP_E2E_GLITCHTIP=1 adds the GlitchTip check (needs make k8s-sourcemaps first); LOCAL LAB ONLY: deletes the register rate limit keys in the cluster's Valkey db 10
	@$(NODE) $(BACKEND) bash e2e/k3d-e2e.sh
