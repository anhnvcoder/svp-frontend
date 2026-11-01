# svp-frontend

Web client của nền tảng video ngắn mini (lab học DevOps + Solution Architect): Next.js App Router, BFF chạy trong cùng server
Next (session ở Redis, gọi gateway của backend), feed dọc phát HLS, hồ sơ, tải video lên bằng presigned POST.

Repo này là phía "team FE" của lab. Backend (`anhnvcoder/svp-backend`) giữ service Go, hợp đồng REST của gateway,
stack compose và cluster k3d; `anhnvcoder/svp-gitops` giữ môi trường nào chạy bản nào. Hai phía nói chuyện với nhau qua **hợp đồng
API có version và chữ ký**, không qua file chép tay. Lý do tách và các quyết định:
[ADR-0033](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0033-svp-web-repo.md); thiết kế web client và danh
sách gói được dùng: [ADR-0016](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0016-web-client.md).

## Cần có

- **Node 26** (`.nvmrc`, cài bằng nvm: `nvm install 26`) và **pnpm** đúng version ở `packageManager` của `package.json`
  (`npm install -g pnpm@<version>`; Node 25 trở đi không có Corepack). Mọi target `make` chạy Node tự đặt Node 26 mới nhất của nvm lên
  đầu `PATH`, kiểm major Node và version pnpm, lệch thì in lệnh cài và dừng.
- Docker (trivy, ORAS, cosign chạy bằng image ghim digest, không cài), `jq`, `git`.
- Redis local `127.0.0.1:6379` cho test (db 15) và `make dev` (db 9).
- Bản clone backend ở `<workspace>/backend` cho mọi việc cần stack (e2e, đo, Lighthouse, source map): cùng thư mục cha với repo
  này, hoặc đặt `SVP_BACKEND_DIR` tới một bản clone khác.

```text
<workspace>/
  backend/    anhnvcoder/svp-backend
  frontend/   repo này (anhnvcoder/svp-frontend)
  gitops/     anhnvcoder/svp-gitops
```

## Lệnh

`make help` liệt kê mọi target.

| Lệnh                                                                                        | Việc                                                                                                                                               |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make install`                                                                              | `pnpm install --frozen-lockfile`                                                                                                                   |
| `make dev`                                                                                  | `next dev` ở `http://localhost:3002`, trỏ gateway `127.0.0.1:8080` của backend, session ở Redis db 9                                               |
| `make check`                                                                                | ESLint, Prettier, typecheck, Vitest (Redis db 15 qua `SVP_TEST_REDIS_URL`), `next build`, khởi động thử server standalone, ngân sách bundle        |
| `make generate`                                                                             | sinh `gen/api.d.ts` từ hợp đồng đã phát hành mà `api/contract.json` ghim, sau khi kiểm digest và chữ ký                                            |
| `make generate-check`                                                                       | như trên vào thư mục tạm, lệch với `gen/api.d.ts` thì in diff và đỏ; không ghi gì dưới `gen/`                                                      |
| `make lockfile-scan`                                                                        | trivy quét `pnpm-lock.yaml` (gồm dev dependency); còn CRITICAL sau `.trivyignore.yaml` là đỏ                                                       |
| `make backend-checkout`                                                                     | checkout backend ở commit của `.backend-commit` vào `.backend/` (các target trên tự gọi khi cần)                                                   |
| `make tools`                                                                                | cài `gitleaks`, `actionlint` bằng `go install` đúng version mà `Makefile` của backend ghim (cần Go)                                                |
| `make stg-revision`                                                                         | in commit backend mà stg đang chạy (`revision` của `envs/stg/charts.yaml` trong bản clone `svp-gitops`: `SVP_GITOPS_DIR` hay `<workspace>/gitops`) |
| `make stg-check`                                                                            | đỏ khi backend (`SVP_BACKEND_DIR`) không ở đúng commit đó hay chưa có chế độ `make up IMAGES=stg`                                                  |
| `make e2e`, `make measure-web`, `make measure-upload`, `make lighthouse`, `make sourcemaps` | chạy trên stack compose của backend (`make up` ở backend; `OBS=lgtm` cho source map)                                                               |
| `make k8s-e2e`, `make k8s-sourcemaps`                                                       | như trên với cluster k3d `svp` của backend (`https://svp.localhost:8443`)                                                                          |

Test e2e cần trình duyệt của Playwright, cài một lần: `pnpm exec playwright install chromium webkit`.

**LOCAL LAB ONLY:** seed của e2e, mỗi worker Playwright và Lighthouse xoá khoá rate limit đăng ký `svp:gw:rl:register:*` ở Redis
db 10 của stack (Valkey db 10 của cluster khi chạy k3d), bằng script của backend. Không trỏ các lệnh này vào stack dùng chung.

## Hợp đồng API

- Spec OpenAPI của gateway chỉ có một nguồn: backend, `services/gateway/openapi.yaml`. Backend phát hành mỗi `info.version` thành OCI
  artifact `ghcr.io/anhnvcoder/svp-backend/api/gateway:<version>`, ký keyless bằng workflow phát hành của nó.
- `api/contract.json` ghim bản dùng ở đây: `repository`, `version`, `digest`. `make generate` kéo manifest theo digest (ẩn danh), kiểm
  manifest băm đúng digest, đúng loại artifact và version, tag của version trỏ đúng digest đó, `cosign verify` với identity của nguồn
  phát hành `backend` (đọc từ bảng nguồn của backend ở `.backend-commit`), rồi mới sinh type bằng `openapi-typescript`. Sai một điều thì
  đỏ, `gen/` giữ nguyên.
- Nâng hợp đồng: đổi `version` và `digest` của cùng một bản (Renovate mở PR), `make generate`, commit `gen/api.d.ts`. Major mới là
  thay đổi breaking: sửa code gọi gateway trong cùng PR.
- Không sửa tay `gen/api.d.ts`, không chép file spec vào repo này.

## Commit ghim của backend

`.backend-commit` là chỗ duy nhất ghim commit backend mà repo này dùng script CI (`deploy/ci/`: cổng quét, build, ký và attest SBOM,
`vuln`, rescan, helper của job `promote`) và công cụ ghim digest trong `Makefile` của nó (cả `YQ_IMAGE` của bước promote). `make backend-checkout` đưa `.backend/` (gitignore) về đúng commit đó, chỉ tải khi commit
đổi; `.backend/` có thay đổi chưa commit thì dừng. Renovate theo dõi `main` của backend và mở PR nâng commit.

## Image

`Dockerfile` ở gốc repo, context là gốc repo (`.dockerignore` loại `node_modules`, output build, `.env*`, `.git`, `.backend/` và
công cụ của repo). Image chạy server standalone của Next trên Node distroless; source map trình duyệt không vào image, nằm ở stage
`sourcemaps` (`make sourcemaps`, `make k8s-sourcemaps` tải lên GlitchTip của stack local). Build, quét, ký image phát hành chạy trong CI
của repo này bằng script backend ở `.backend-commit`; promote lên stg là bước `yq` + `gh` của chính job `promote` (helper `yq_`,
`promote_open_pr`, `promote_image_row` của `deploy/ci/common.sh` ở commit ghim).

## CI và phát hành

Workflow ở `.github/workflows/` chỉ nối bước (trừ job `promote`, bước của nó viết ngay trong `images.yml`); logic nằm ở `Makefile` của
repo này và ở `deploy/ci/` của backend, chạy từ `.backend/`
với `SVP_CODE_ROOT` trỏ checkout của repo này (script backend chọn nguồn phát hành `web` theo repository, đẩy dưới prefix
`ghcr.io/anhnvcoder/svp-frontend/`, ký bằng identity của workflow phát hành của repo này). Mọi action ghim SHA commit, `permissions: {}` ở đầu
file, mọi job của PR chỉ `contents: read` và không secret.

- `ci.yml` (PR, push `main`, chạy tay): `check` (`make install`, `make check`, `make generate-check`, `make lockfile-scan`), `config`
  (luật của `.trivyignore.yaml` và `.grype.yaml`, `actionlint`), `gitleaks` (toàn lịch sử), `sarif` (chỉ `main`), check
  tổng `ci-ok` (đủ `check`, `config`, `gitleaks`). Job `stack` (chỉ báo, ngoài `ci-ok`): đọc commit backend mà stg chạy
  (`make stg-revision`), checkout backend ở commit đó (`make stg-check`), `make up IMAGES=stg WEB_FROM=clone` của backend (sáu service
  backend là bản phát hành của stg theo digest, web build từ PR này), `make smoke`, `make e2e`, `make lighthouse` (đỏ không làm job đỏ).
- `images.yml` (PR, push `main`, chạy tay, lịch hằng ngày): `plan`; PR chỉ `build-nopush` (build, quét hai chân amd64, arm64); `main`:
  `build` (trivy chặn bí mật và CRITICAL còn lại sau `.trivyignore.yaml`, grype trên SBOM chặn Critical còn lại sau `.grype.yaml`,
  rồi mới push), `merge` (index đa kiến trúc), `sign` (cosign keyless:
  chữ ký, SBOM, attestation `vuln` ở dạng Sigstore bundle; rồi build provenance bằng `actions/attest`, quyền `attestations: write` chỉ ở
  job này), `promote` (environment `promote`, token một giờ của GitHub App `svp-web-promoter` chỉ
  trên `svp-gitops`: clone `svp-gitops`, dựng nhánh `bot/promote-stg-web` một commit của bot trên `main`, `yq_ -i` (yq theo
  `YQ_IMAGE` ghim digest trong `Makefile` của backend ở `.backend-commit`, không mạng) đúng khối `image` của
  `envs/stg/images/web.yaml` (không bao giờ `envs/stg/charts.yaml`), từ chối commit cũ hơn bản web mà `main` hay PR đang mở ghi (so tổ
  tiên), push `--force-with-lease`, `gh pr create`/`edit`, `gh pr merge --auto --squash --match-head-commit`: PR tự merge khi
  `gitops-ok` xanh), `rescan`
  (lịch hằng ngày: quét lại và attest lại bản web của repo này đang ở `envs/*/images/`, không đụng bản của backend), `sarif`, check
  tổng `images-ok`.
- Ruleset `main` (Terraform ở `github/rulesets.tf` của `svp-infra`): PR bắt buộc, `ci-ok` và `images-ok` từ app GitHub Actions, cấm xoá và force push, không
  ai bypass. Promote prd làm ở backend (chép giá trị `envs/stg/` của `svp-gitops` ở `stg_ref` vào `envs/prd/`, PR do Code Owner duyệt).
- Renovate (App Mend, `renovate.json`): PR `patch`, `digest` của gói npm, pnpm, Node, base image và service container của CI tự merge
  khi `ci-ok`, `images-ok` xanh (auto-merge của GitHub, squash; repo phải bật "Allow auto-merge"), nên vào stg như một merge tay; PR của
  action, `.backend-commit`, `api/contract.json` và mọi minor, major chờ người duyệt ([ADR-0035](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0035-renovate-automerge.md)).
