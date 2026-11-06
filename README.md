# svp-frontend

Web client của nền tảng video ngắn mini svp: Next.js App Router, BFF chạy trong cùng server Next (session ở Redis, gọi gateway
của backend), feed dọc phát HLS, hồ sơ, tải video lên bằng presigned POST.

## Mục lục

- [Bối cảnh](#bối-cảnh)
- [Cài đặt](#cài-đặt)
- [Sử dụng](#sử-dụng)
- [Hợp đồng API](#hợp-đồng-api)
- [Commit ghim của backend](#commit-ghim-của-backend)
- [Image](#image)
- [CI và phát hành](#ci-và-phát-hành)
- [Đóng góp](#đóng-góp)
- [Giấy phép](#giấy-phép)

## Bối cảnh

svp là lab học DevOps và Solution Architect. Repo này là phía "team FE" của lab. Backend (`anhnvcoder/svp-backend`) giữ service
Go, hợp đồng REST của gateway, stack compose và cluster k3d; `anhnvcoder/svp-gitops` giữ môi trường nào chạy bản nào. Hai phía
nói chuyện với nhau qua **hợp đồng API có version và chữ ký**, không qua file chép tay. Lý do tách và các quyết định:
[ADR-0033](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0033-svp-web-repo.md); thiết kế web client và danh
sách gói được dùng: [ADR-0016](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0016-web-client.md). Bản chép
thiết kế giao diện nằm ở [`design/`](design/README.md).

## Cài đặt

Cần có:

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

Cài gói đúng như `pnpm-lock.yaml` ghim, và trình duyệt của Playwright cho test e2e (một lần):

```sh
make install
pnpm exec playwright install chromium webkit
```

## Sử dụng

`make help` liệt kê mọi target.

| Lệnh | Việc |
| --- | --- |
| `make install` | `pnpm install --frozen-lockfile` |
| `make dev` | `next dev` ở `http://localhost:3002`, trỏ gateway `127.0.0.1:8080` của backend, session ở Redis db 9 |
| `make check` | ESLint, Prettier, typecheck, Vitest (Redis db 15 qua `SVP_TEST_REDIS_URL`), `next build`, khởi động thử server standalone, ngân sách bundle |
| `make generate` | sinh `gen/api.d.ts` từ hợp đồng đã phát hành mà `api/contract.json` ghim, sau khi kiểm digest và chữ ký |
| `make generate-check` | như trên vào thư mục tạm, lệch với `gen/api.d.ts` thì in diff và đỏ; không ghi gì dưới `gen/` |
| `make lockfile-scan` | trivy quét `pnpm-lock.yaml` (gồm dev dependency); còn CRITICAL sau `.trivyignore.yaml` là đỏ |
| `make backend-checkout` | checkout backend ở commit của `.backend-commit` vào `.backend/` (các target trên tự gọi khi cần) |
| `make tools` | cài `gitleaks`, `actionlint` bằng `go install` đúng version mà `Makefile` của backend ghim (cần Go) |
| `make zizmor` | lint bảo mật mọi workflow bằng zizmor ghim digest (`ZIZMOR_IMAGE`); trên máy chỉ offline, có `GH_TOKEN` (CI) thì thêm audit online |
| `make docs-check` | markdownlint-cli2 và lychee (`--offline`: link nội bộ, anchor heading) trên mọi file `.md` của repo, image ghim digest, không mạng; `DOCS='<file hay glob>'` thu hẹp |
| `make stg-revision` | in commit backend mà stg đang chạy (`revision` của `envs/stg/charts.yaml` trong bản clone `svp-gitops`: `SVP_GITOPS_DIR` hay `<workspace>/gitops`) |
| `make stg-check` | đỏ khi backend (`SVP_BACKEND_DIR`) không ở đúng commit đó hay chưa có chế độ `make up IMAGES=stg` |
| `make e2e`, `make measure-web`, `make measure-upload`, `make lighthouse`, `make sourcemaps` | chạy trên stack compose của backend (`make up` ở backend; `OBS=lgtm` cho source map) |
| `make k8s-e2e`, `make k8s-sourcemaps` | như trên với cluster k3d `svp` của backend (`https://svp.localhost:8443`) |

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

`.backend-commit` là chỗ duy nhất ghim commit backend mà repo này dùng composite action của pipeline image (`.github/actions/image-leg`,
`image-index`, `image-sign`: build, quét, cổng, đẩy, gộp index, ký và attest SBOM, `vuln`, provenance), script CI (`deploy/ci/`: `plan.sh`,
luật file ngoại lệ, rescan, helper của job `promote`) và công cụ ghim digest trong `Makefile` của nó (cả `YQ_IMAGE` của bước promote). `make backend-checkout` đưa `.backend/` (gitignore) về đúng commit đó, chỉ tải khi commit
đổi; `.backend/` có thay đổi chưa commit thì dừng. Renovate theo dõi `main` của backend và mở PR nâng commit.

## Image

`Dockerfile` ở gốc repo, context là gốc repo (`.dockerignore` loại `node_modules`, output build, `.env*`, `.git`, `.backend/` và
công cụ của repo). Image chạy server standalone của Next trên Node distroless; source map trình duyệt không vào image, nằm ở stage
`sourcemaps` (`make sourcemaps`, `make k8s-sourcemaps` tải lên GlitchTip của stack local). Build, quét, ký image phát hành chạy trong CI
của repo này bằng composite action của backend ở `.backend-commit`; promote lên stg là bước `yq` + `gh` của chính job `promote` (helper `yq_`,
`promote_open_pr`, `promote_image_row` của `deploy/ci/common.sh` ở commit ghim).

## CI và phát hành

Workflow ở `.github/workflows/` chỉ nối bước (trừ job `promote`, bước của nó viết ngay trong `images.yml`); logic nằm ở `Makefile` của
repo này, ở composite action `image-leg`, `image-index`, `image-sign` của backend (`uses: ./.backend/.github/actions/<tên>` sau
`make backend-checkout`, input `code-root` là checkout của repo này) và ở `deploy/ci/` của backend, chạy từ `.backend/` với `SVP_CODE_ROOT`
trỏ checkout của repo này (action và script backend chọn nguồn phát hành `web` theo repository, đẩy dưới prefix
`ghcr.io/anhnvcoder/svp-frontend/`, ký bằng identity của workflow phát hành của repo này: bước của composite action chạy trong job gọi nó; các
action từ chối chạy khi HEAD của checkout này không phải commit của lượt).

Repo public và PR từ fork chạy workflow với code của fork, nên mọi workflow theo cùng luật:

- Không `pull_request_target`, không `workflow_run`: PR không bao giờ chạy với token ghi hay secret.
- `permissions: {}` ở đầu file, mỗi job khai đúng quyền nó cần. Mọi job chạy ở PR chỉ `contents: read` và không secret: PR chạy code của nó
  (và script của commit backend nó ghim) trước khi ai đọc. Job có quyền ghi (`packages`, `id-token`, `attestations`, `security-events`) chỉ
  chạy trên `main`, ngoài PR.
- Mọi action ghim SHA đầy đủ của commit: tag bị dời sang code khác không đổi gì ở đây (tag ở comment cuối dòng cho người đọc và Renovate).
- `actions/checkout` không để token trong `.git/config` (`persist-credentials: false`).
- Giá trị người ngoài điều khiển (tên nhánh, tiêu đề, input, giá trị matrix từ `plan`) vào script qua `env:`, không qua `${{ }}` trong `run:`.

Từng workflow, ruleset và Renovate:

- `ci.yml` (PR, push `main`, chạy tay): `check` (`make install`, `make check`, `make generate-check`, `make lockfile-scan`), `config`
  (luật của `.trivyignore.yaml` và `.grype.yaml`, `actionlint`), `gitleaks` (toàn lịch sử), `zizmor` (`make zizmor`, mọi finding
  chặn trừ ngoại lệ có lý do ở `.github/zizmor.yml`), `dependency-review` (chỉ PR: dependency PR thêm hay đổi có lỗ hổng high trở lên
  là đỏ), `docs` (`make docs-check`), `sarif` (chỉ `main`), check tổng `ci-ok` (cần mọi job trên trừ `sarif`; `dependency-review`
  được `skipped` khi sự kiện không phải PR; job `changes` chia PR theo vùng: PR chỉ tài liệu (`.md`, `docs/`, `LICENSE`) bỏ qua `check`,
  `config`, `stack`, PR không đụng `.github/` bỏ qua `zizmor`, `stack` bỏ qua cả khi chỉ đổi `.github/`; đổi `Makefile`,
  `.backend-commit` hay `ci.yml` thì chạy hết (file đổi tên xét cả tên cũ; API liệt kê thiếu file thì cũng chạy hết); `ci-ok` nhận đúng các skip đó). Job `stack` (ngoài `ci-ok`, không chặn merge): đọc commit backend mà stg chạy
  (`make stg-revision`), checkout backend ở commit đó (`make stg-check`), `make up IMAGES=stg WEB_FROM=clone` của backend (sáu service
  backend là bản phát hành của stg theo digest, web build từ PR này), `make smoke`, `make e2e`, `make lighthouse` (ba lượt mỗi trang, ngưỡng LCP, CLS, TBT và điểm accessibility lấy trung vị: vượt ngưỡng là job `stack` đỏ). Playwright thử lại test đỏ tối đa hai lần trên CI (`retries` ở `playwright.config.ts`); lượt đo luôn 0.
  - `ci-ok` là check duy nhất ruleset `main` đòi từ workflow này, nên job khác đổi tên hay thêm mà không đụng ruleset. `gitleaks`, `docs`,
    `dependency-review` luôn chạy; `changes` lấy danh sách file từ API của GitHub chứ không từ git nên không fetch lịch sử.
  - `check` chạy `make lockfile-scan` cả khi bước trước đỏ để PR luôn thấy kết quả của cổng: CRITICAL trong `pnpm-lock.yaml` (cả dev
    dependency) làm job đỏ, HIGH chỉ vào SARIF; SARIF được ghi trước khi cổng quyết định, job `sarif` đưa nó lên trên `main`.
  - `config` là nơi duy nhất mục ngoại lệ hết hạn làm đỏ (grype không đọc ngày nên rule của nó vẫn che match), và một mục hay rule hỏng merge
    vào `main` sẽ chặn cổng của image và rescan hằng ngày của bản web. Luật là policy conftest của backend, không mạng, không token.
  - `stack`: ba repo nằm cạnh nhau như workspace của lab (`frontend/`, `backend/`, `gitops/`), mỗi script biết hai repo kia qua `SVP_*_DIR`.
    Lượt đỏ (test e2e chập chờn trên runner dùng chung, ngưỡng Lighthouse, bản backend mà stg chưa ổn định) không chặn merge; người đọc PR
    thấy kết quả dưới tên job. Job build và chạy code của PR với `contents: read` và không secret: `make env` của backend ghi một `.env` toàn
    secret ngẫu nhiên mới, chỉ nằm trên runner tới hết job, không in, không tải lên. Các bước xoá khoá rate limit **LOCAL LAB ONLY** của smoke,
    seed e2e và Lighthouse (khoá đăng ký ở Redis db 10) chỉ chạm service container Redis của chính lượt này. Công cụ của script lấy từ kho
    Ubuntu (không action bên thứ ba): `psql` cho bootstrap Postgres (bản 16, SQL cần từ 15), `redis-cli` cho bước xoá rate limit, `ffmpeg`
    cho video thử, `jq`; `curl` và `openssl` có sẵn trong image runner.
  - `sarif`: job duy nhất có quyền ghi (`security-events: write`); finding của PR nằm ở artifact và tóm tắt job. Job checkout chỉ để
    `upload-sarif` đọc dòng của từng finding và tính fingerprint (alert qua được việc lệch dòng cùng lịch sử và việc dismiss), không chạy gì
    của repo. Là báo cáo chứ không phải check: upload lỗi vẫn làm lượt chạy đỏ.
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
  - Luồng: image `ghcr.io/anhnvcoder/svp-frontend/web` build mỗi lượt từ cả cây trên runner amd64 và arm64 gốc; image cục bộ quét bằng trivy và
    SBOM bằng grype, chặn bí mật và CRITICAL **trước** khi đẩy gì; chỉ đẩy đúng cái đã quét, rồi ghép index đa kiến trúc, ký keyless bằng cosign,
    attest SBOM (syft) và kết quả quét, sau đó build provenance (`actions/attest`), tất cả là Sigstore bundle; digest đã ký được promote lên stg
    qua PR ở `svp-gitops`, và digest đã phát hành được quét lại hằng ngày.
  - Một lần ghim cho cả bộ: action, guard của chúng (`deploy/ci/image-guard.sh` cạnh chúng) và image công cụ mà `Makefile` của backend ghim digest
    đi cùng `.backend-commit`. Input `code-root`, và `SVP_CODE_ROOT` cho script backend mà file này chạy (`deploy/ci/plan.sh`,
    `deploy/ci/rescan.sh`), báo rằng code được build và phát hành là checkout này chứ không phải của backend: chúng lấy nguồn phát hành có
    repository là repo này (`deploy/helm/svp-policy/files/sources.json` của `.backend/`), đẩy dưới prefix của nó, ký bằng identity của nó và từ
    chối chạy khi HEAD ở đây không là commit của lượt. Bước của composite action chạy trong job gọi nó, nên chứng chỉ keyless và build
    provenance mang tên workflow này, identity của nguồn `web`. Workflow chỉ nối job, quyền và artifact; ngoại lệ là job `promote`, có bước viết
    ngay ở đây, dùng ba helper của `deploy/ci/common.sh` ở backend: `yq_`, `promote_open_pr`, `promote_image_row`.
  - Quyền: chỉ job `promote` ghi vào repo khác. Environment `promote` (nhánh triển khai chỉ `main`) giữ khoá GitHub App `svp-web-promoter` cài
    riêng trên `svp-gitops`; job đổi khoá thành token một giờ cho `svp-gitops` với quyền `contents` và `pull-requests` write, thu hồi khi job kết
    thúc; `GITHUB_TOKEN` chỉ đọc repo này; không `id-token`, không `packages`. Không job PR nào gọi environment đó hay đọc secret. Chỉ dùng action
    của GitHub, `sigstore/cosign-installer` và composite action của backend dưới `.backend/.github/actions/` (ghim bởi `.backend-commit`; chúng chỉ
    gọi action của GitHub ở SHA chúng ghim). Không job nào đẩy vào repo này nên checkout không giữ token.
  - `sign`: chữ ký keyless trên digest của index, attestation SBOM trên từng manifest, attestation `vuln` (cả hai lượt quét) trên index, với cosign
    mà `Makefile` của backend ghim; rồi build provenance (SLSA v1, `actions/attest` dựng từ claim của token OIDC của lượt) trên index, sau chữ ký và
    attestation `vuln` (action `image-sign`). Action từ chối ký trừ khi workflow của lượt là subject của nguồn phát hành của repo này (`images.yml`
    ở `refs/heads/main`, identity mà Kyverno nhận cho `web` từ đây), và chỉ ghi mỗi bundle khi digest chưa có bundle cùng loại (chạy lại một lượt
    không ký hai lần). Đây là job duy nhất của đường build có `id-token: write` và `attestations: write` (provenance cũng vào attestations của
    repo); không dùng cache. Artifact `release-<image>` (repository, tag, digest của index đã ký) là thứ `promote` ghi vào `envs/stg/images/`
    của `svp-gitops`.
  - `promote`: dựng lại nhánh `bot/promote-stg-web` thành một commit của bot trên `main` ở đó, đặt khối `image` của `envs/stg/images/web.yaml` về
    bản lượt này vừa ký (comment của file giữ nguyên), mở hay cập nhật PR và bật auto-merge; `svp-gitops` merge khi `gitops-ok` xanh, không cần
    duyệt (không Code Owner nào giữ `envs/stg/`). Không bao giờ ghi `envs/stg/charts.yaml`: chart là của backend. Job chạy cả khi bước ký lỗi,
    khi đó không promote gì. Các lượt của `main` nối đuôi nhau (nhóm concurrency của build không bao giờ huỷ) nên lượt sau không promote trước
    lượt trước; bước từ chối lượt có commit cũ hơn bản `web` mà `main` của `svp-gitops` hay PR đang mở nêu (lượt chạy lại, dispatch một commit cũ),
    so bằng quan hệ tổ tiên chứ không bằng thời gian. `yq_` là yq của `YQ_IMAGE` (ghim digest trong `Makefile` của backend, không mạng): yq cài
    sẵn trên runner đổi theo image runner mà không ai thấy, trong khi bước này ghi vào repo triển khai. `promote_open_pr` tìm PR đang mở của app
    từ một nhánh, không bao giờ của fork; `gh` lỗi hay danh sách dài quá mức tin được thì lỗi. `promote_image_row` là dòng của bảng ở body PR.
    `source` file đó chỉ định nghĩa hàm, không chạy gì.
  - `rescan` (lịch hằng ngày, hay dispatch với `rescan=true`): mỗi digest `web` của repo này mà `svp-gitops` nêu (`envs/*/images/` ở `main` và ở
    PR đang mở `bot/promote-stg-web`) được quét lại theo từng manifest; attestation `vuln` được thay bằng kết quả thật, ký bằng identity của
    workflow này (theo định dạng mà digest được ký; với Sigstore bundle thì các bundle `vuln` cũ bị gỡ, cần `packages: write`). CRITICAL được
    ghi lại trước rồi mới làm job đỏ (mail cho chủ repo); bí mật làm job đỏ trước khi attest gì (`deploy/ci/rescan.sh`). Bản của backend để
    rescan của backend lo: `--source web` làm script kiểm lượt này đúng là của nguồn phát hành của repo này và workflow ký của nó trước khi đọc gì,
    nên không bao giờ thay attestation của bản phát hành repo khác. `svp-gitops` được clone ẩn danh và file của nó chỉ đọc như dữ liệu, không chạy;
    `GITHUB_TOKEN` chỉ để hỏi PR promote có đang mở không (đọc repo public). Không cache vì job giữ `id-token`.
- `pr-title.yml` (PR mở, sửa, mở lại, push mới): job `pr-title` kiểm tiêu đề PR, cũng là tiêu đề commit squash, theo Conventional
  Commits: `<type>[(<scope>)][!]: <mô tả>`, type là `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `perf`, `revert`,
  hay `Revert "<tiêu đề>"` của nút Revert; không danh sách scope, nên `chore(deps): …`, `fix(deps): …` của Renovate và
  `chore: ghim backend …` qua nguyên ([ADR-0041](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0041-github-hardening.md) (h)).
  Cùng regex và bộ tiêu đề thử chạy ở bốn repo có CI (`svp-backend`, `svp-frontend`, `svp-gitops`, `svp-infra`). Workflow riêng, không phải job của
  `ci.yml`: sửa tiêu đề chỉ chạy lại nó, không chạy lại cả CI; không quyền, không checkout, không code của PR, tiêu đề vào script qua `env`.
- `scorecard.yml` (push `main`, lịch tuần, và khi luật bảo vệ nhánh kiểu cũ đổi): [OpenSSF Scorecard](https://github.com/ossf/scorecard/blob/main/docs/checks.md)
  của repo (ghim, quyền token, ruleset, mẫu workflow nguy hiểm và các check khác), kết quả công khai ở API Scorecard
  ([viewer](https://scorecard.dev/viewer/?uri=github.com/anhnvcoder/svp-frontend), `publish_results: true`, huy hiệu) và lên code scanning. Không có
  trigger `pull_request`: không phải check của PR. Check Branch-Protection đọc ruleset bằng `GITHUB_TOKEN` nên không cần `repo_token`. Publish ràng
  buộc file này theo "Workflow Restrictions" mà API Scorecard kiểm trước khi nhận kết quả (README của `ossf/scorecard-action`, mã ở
  `api/app/server/verify_workflow.go` của `ossf/scorecard-infra`): không `env` hay `defaults` ở mức workflow và ở job, không quyền ghi ở mức
  workflow, `id-token: write` chỉ ở job Scorecard, không container hay service, một nhãn runner Ubuntu do GitHub host (`ubuntu-latest` hay
  `ubuntu-YY.MM`, 22.04 trở lên), và chỉ `actions/checkout`, `actions/upload-artifact`, `github/codeql-action/upload-sarif`,
  `ossf/scorecard-action`, `step-security/harden-runner` làm step của job đó, mỗi step là một `uses:` (không step `run:`). API nhận hay không thì
  hiện ở log của step Scorecard.
- Ruleset `main` (Terraform ở `github/rulesets.tf` của `svp-infra`): PR bắt buộc, `ci-ok` và `images-ok` từ app GitHub Actions, chỉ squash,
  lịch sử thẳng, cấm xoá và force push, không ai bypass. Ruleset `owners`: PR đổi đường có chủ trong `CODEOWNERS` (`.github/`,
  `.backend-commit`, `Makefile`, `pnpm-workspace.yaml`, `renovate.json`, `.trivyignore.yaml`, `.grype.yaml`, chính `CODEOWNERS`) cần Code Owner duyệt. Promote prd làm ở backend (chép giá trị `envs/stg/` của `svp-gitops` ở `stg_ref` vào `envs/prd/`) qua hai cổng: người học duyệt environment `promote-prd` của `svp-backend` (admin không bypass, trước khi job lấy khoá App), rồi Code Owner duyệt PR prd ở `svp-gitops`.
- Renovate (App Mend, `renovate.json`): chỉ PR `patch` của npm `devDependencies` chạy trên máy dev và CI tự merge khi `ci-ok`,
  `images-ok` xanh (auto-merge của GitHub, squash; repo phải bật "Allow auto-merge"), nên vào stg như một merge tay; không file nào tự
  merge có Code Owner. Chờ người duyệt: npm `dependencies`; `typescript`, `tailwindcss`, `@tailwindcss/postcss` (chạy trong `next build`
  của image, output vào image); pnpm; Node cùng mọi digest của base image trong `Dockerfile` (`.nvmrc`, `engines` và tag của hai image chỉ
  ghi major, nên mỗi bản minor, patch của Node đến dưới dạng digest mới); image của workflow, công cụ ghim trong `Makefile`, action,
  `.backend-commit`, `api/contract.json` và mọi minor, major
  ([ADR-0041](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0041-github-hardening.md) (i)).

## Đóng góp

Quy ước chung của mọi repo: [`CONTRIBUTING.md` của `anhnvcoder/.github`](https://github.com/anhnvcoder/.github/blob/main/CONTRIBUTING.md);
luật riêng của repo này (lệnh kiểm, quy ước test, an toàn database và cloud): [`AGENTS.md`](AGENTS.md).

## Giấy phép

Phát hành theo giấy phép Apache-2.0, xem [`LICENSE`](LICENSE).
