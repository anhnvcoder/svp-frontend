# svp-frontend

Web client của nền tảng video ngắn mini svp: Next.js App Router, BFF chạy trong cùng server Next (session ở Redis, gọi gateway
của backend), feed dọc phát HLS, hồ sơ, tải video lên bằng presigned POST.

## Mục lục

- [Bối cảnh](#bối-cảnh)
- [Kiến trúc](docs/architecture.md)
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
thiết kế giao diện nằm ở [`design/`](design/README.md). Vì sao code TypeScript viết như hiện tại: [`docs/architecture.md`](docs/architecture.md).

## Cài đặt

Cần có:

- **Node 26** (`.nvmrc`, cài bằng nvm: `nvm install 26`) và **pnpm** đúng version ở `packageManager` của `package.json`
  (`npm install -g pnpm@<version>`; Node 25 trở đi không có Corepack). Mọi target `make` chạy Node tự đặt Node 26 mới nhất của nvm lên
  đầu `PATH`, kiểm major Node và version pnpm, lệch thì in lệnh cài và dừng.
- Docker (trivy, ORAS, cosign chạy bằng image ghim digest, không cài), `jq`, `git`.
- Redis local `127.0.0.1:6379` cho test (db 15) và `make dev` (db 9). Web trong compose và k3d của backend không dùng nó mà dùng Valkey
  của stack (TLS, user `svp-web`, db 9).
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

`pnpm-workspace.yaml` có các override cho những gói chỉ `@lhci/cli` (`make lighthouse`) kéo vào; không gói nào trong số đó tới image web.
`@lhci/cli` 0.15.1 là bản mới nhất của nó và ghim lighthouse 12.6.1, nên một gói cha mới hơn không mang được các bản vá này vào. Mỗi
override giới hạn ở gói cha yêu cầu nó, nên không dependent nào khác bị dời theo. Khoá của override nêu gói cha mà không nêu version: pnpm
im lặng bỏ qua override có version của gói cha không còn khớp, nên `cha@1.2.3>con` sẽ mất bản vá ở lần nâng gói cha kế tiếp, trong khi
`install --frozen-lockfile` vẫn xanh. Gói con mang dải yêu cầu mà không bản đã vá nào thoả (pnpm áp override khi dải đó giao với dải
gói cha hỏi), nên một gói cha về sau hỏi dải đã có bản vá sẽ tự giải quyết và không bị ép về các version này.

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

**LOCAL LAB ONLY:** seed của e2e, mỗi worker Playwright và Lighthouse xoá khoá rate limit đăng ký `svp:gw:rl:register:*` ở Valkey
db 10 của stack (Valkey của cluster khi chạy k3d), bằng `svp-valkey` của backend (user `svp-ops`). Không trỏ các lệnh này vào stack dùng chung.

### Chi tiết từng target

- **`make zizmor`:** zizmor persona `regular` trên cả repo, từ image chính thức ghim digest (đa kiến trúc: cùng một tham chiếu trên máy
  arm64 và runner amd64), repo mount chỉ đọc. Mọi finding làm đỏ (exit code 11 đến 14); ngoại lệ có chủ đích nằm ở
  `.github/zizmor.yml`, mỗi cái kèm lý do. Có `GH_TOKEN` (CI truyền `GITHUB_TOKEN` chỉ đọc của job) thì thêm audit online (impostor
  commit, action có lỗ hổng đã biết); không có thì chỉ audit offline. `ZIZMOR_FORMAT=github` ghi workflow command (annotation trong CI);
  `ZIZMOR_SARIF=<đường>` ghi báo cáo SARIF vào đó thay vì in, và không bao giờ đỏ vì finding (báo cáo cho bước upload code scanning).
- **`make docs-check`:** markdownlint-cli2 với `.markdownlint.yaml` (văn phong), rồi lychee `--offline --include-fragments` (link tương
  đối và anchor heading; link tới site khác không được theo vì mạng không ổn định và một check phụ thuộc nó sẽ đỏ vì lý do ngoài thay
  đổi). Cả hai chạy từ image chính thức ghim digest (đa kiến trúc), không mạng, repo mount chỉ đọc ở `/repo`: link tương đối đi ra
  ngoài repo là lỗi, có chủ đích. `DOCS` thu hẹp danh sách file (đường hay glob, tính từ gốc repo); mặc định là mọi file Markdown mà git
  theo dõi cộng file mới chưa theo dõi, trừ những gì không phải văn bản của repo này: bản checkout backend (`.backend/`), các gói
  (`node_modules/`) và code sinh (`gen/`). Cả hai công cụ luôn chạy; exit code khác 0 khi một trong hai báo lỗi.
- **Ngân sách bundle** (trong `make check`): `size-limit` đo gzip trên output của `next build` theo `.size-limit.json`. Mỗi route có hai
  ngân sách. Ngân sách thứ nhất tính phần route thêm vào runtime của Next: các chunk mà client reference manifest của build liệt kê cho
  layout, page và error boundary của route (các script trong HTML của nó), cộng các chunk chúng tải lười (hls.js ở feed và `/v/[id]`).
  Ngân sách thứ hai tính cả lần tải đầu: tập đó cộng runtime (`rootMainFiles` của `build-manifest.json`: React, react-dom, router của
  Next, giống nhau ở mọi route), nên runtime phình ra cũng làm check đỏ. Polyfill `nomodule`, mà trình duyệt hiện hành bỏ qua, không
  tính vào cả hai. Turbopack đặt tên chunk theo hash nội dung, nên mỗi tập được chép vào `.next/size-limit/<tập>/` trước, nơi glob của
  cấu hình tìm thấy chúng. Bản chép bỏ dòng cuối của mỗi chunk, comment `sourceMappingURL`, như bước build của image làm
  ([Image](#image)): ngân sách đếm đúng số byte image phục vụ, kể cả debug id.
- **Khởi động thử server standalone** (trong `make check`): server standalone của `next build`, đúng cái image chạy, được khởi động một
  lần và hỏi `/healthz`. Một module mà hook instrumentation nạp nhưng bản build bỏ sót (một `require` mà bundler và bước trace không
  theo được) vẫn qua unit test và `next build`, nhưng làm mọi route của image trả 500. Server chỉ nghe trên `127.0.0.1`, ở một cổng
  trống mà check tự chọn; nó nhận một môi trường cố định chứ không phải của shell này, với các host kết thúc bằng `.invalid`: `/healthz`
  không đọc Redis hay gateway, nên không chạm gì. Server được dừng bằng handle của chính nó khi đã trả lời.
- **`make lockfile-scan`:** cổng lỗ hổng của các npm dependency, đọc từ lockfile: image chỉ cho trivy thấy ít gói còn lại trong
  `node_modules`, vì bundler gấp dependency của server vào chunk của nó. Dev dependency cũng tính: chúng chạy trong CI và build ra
  bundle được phát hành. trivy quyết định bằng cờ của chính nó (`convert --exit-code --severity CRITICAL`), với
  `.trivyignore.yaml` của repo này: còn CRITICAL nào sau đó cũng đỏ, đã có bản vá ở upstream hay chưa, và bảng của nó được in; HIGH
  cũng vào SARIF, các mức thấp hơn thì không vào đâu. Chỉ lockfile được mount (chỉ đọc), thành `pnpm-lock.yaml` của gốc quét, để
  finding trỏ vào file của repo. Báo cáo không có gói npm nào cũng đỏ: một định dạng lockfile mà trivy không còn đọc được sẽ qua mà
  không quét gì. trivy chạy từ image mà `Makefile` của backend ghim và cần mạng để tải DB; DB không tải được thì target đỏ: không quét
  với DB không rõ tuổi. `LOCKFILE` (đường tuyệt đối của file tên `pnpm-lock.yaml`) quét một lockfile khác, cho kiểm tra phủ định.
  `LOCKFILE_SARIF` đặt thành đường tuyệt đối thì ghi báo cáo SARIF của finding HIGH và CRITICAL vào đó, trước khi cổng quyết định, nên một
  lockfile bị chặn vẫn hiện trên `main`. `SVP_TRIVY_CACHE`, khi đặt, giữ DB ở thư mục đó; không đặt thì DB nằm trong cache bên trong
  container.
- **`make k8s-e2e`** (`e2e/k3d-e2e.sh`, chạy từ gốc repo, `Makefile` đặt Node và pnpm lên đầu `PATH`): test end-to-end `e2e/*.e2e.ts`
  trên web của cluster `svp` ở `https://svp.localhost:8443` thay vì stack compose (`e2e/stack.ts`), trên Chromium và WebKit.
  - `.k8s/ca.crt` và API của cluster phải có, nếu không không chạy gì. Sau đó `SVP_STACK=k3d`, và curl (`e2e/seed.sh`) cùng Node (`fetch`
    của chính các spec) tin CA của cluster qua `CURL_CA_BUNDLE` và `NODE_EXTRA_CA_CERTS`; trình duyệt bỏ qua kiểm chứng chỉ (lý do ở
    `e2e/stack.ts`).
  - `SVP_E2E_GLITCHTIP=1` thêm `e2e/glitchtip.e2e.ts`, đọc API GlitchTip của cluster: token chỉ đọc của Secret
    `svp-obs/glitchtip-api` vào `SVP_E2E_GLITCHTIP_TOKEN` của môi trường lượt chạy mà thôi (không in, không lên dòng lệnh), và một
    port-forward tới `service/glitchtip` ở `127.0.0.1:8000` (cổng của `make k8s-ui-glitchtip` và `make k8s-sourcemaps`) sống suốt lượt
    chạy, dừng bằng pid của nó dù lượt chạy kết thúc thế nào.
  - `SVP_E2E_EVIDENCE` và mọi đối số được chuyển tiếp cho `playwright test`, như `make e2e`.
  - **LOCAL LAB ONLY**, như `make e2e`: `e2e/seed.sh` và mọi worker Playwright xoá các khoá rate limit đăng ký của gateway
    (`svp:gw:rl:register:*`) ở Valkey db 10 của cluster (`svp-valkey` trong Deployment `svp-ops`, context `k3d-svp`). Không trỏ nó vào cluster dùng chung.
- **`make measure-upload`** (`e2e/measure-upload.sh`, chạy từ gốc repo trên stack compose của backend, tức `make up` ở đó): một lần upload
  video khoảng 100 MB từ Chromium qua `/upload` (`e2e/measure-upload.e2e.ts`), rồi một bản tóm tắt: thời gian từ lúc XHR bắt đầu tới lúc
  load xong, thông lượng, CPU của main thread của trang trong lúc file lên, và thời gian tới `READY`; in ra và ghi vào
  `test-results/measure-upload-<giờ UTC>.json` (gitignore). Video là video thật và được transcode: 160 s test pattern 1080p có nhiễu ở
  khoảng 5 Mbit/s, tức khoảng 100 MB mà vẫn dưới 180 s mà web và media-worker nhận. Nó được tạo trong một thư mục tạm, xoá khi kết thúc.
  **LOCAL LAB ONLY**, như lượt e2e (`e2e/seed.sh` đặt lại rate limit đăng ký của gateway ở Valkey db 10).
- **`make measure-web`** (`e2e/measure-web.sh`, chạy từ gốc repo trên stack compose của backend): bộ nhớ của container `web` lúc nghỉ,
  cả lượt e2e (gồm test khung hình đầu, `e2e/first-frame.e2e.ts`), bộ nhớ ngay sau đó, rồi một bản tóm tắt: thời gian tới khung hình đầu
  p50/p95 theo trình duyệt và hai số đọc bộ nhớ, in ra và ghi vào `test-results/measure-web-<giờ UTC>.json` (gitignore). Bộ nhớ là
  `MemUsage` của `docker stats --no-stream`, tức bộ nhớ cgroup của container trừ phần cache file không hoạt động; "lúc nghỉ" là lúc
  script này bắt đầu, nên chạy nó ngay sau `make up` của backend để có số đọc lúc nghỉ. Thoát với status của lượt e2e.
  **LOCAL LAB ONLY**, như chính lượt e2e (`e2e/seed.sh` đặt lại rate limit đăng ký của gateway ở Valkey db 10).
- **Dữ liệu seed của e2e** (`e2e/seed.sh`): chạy một lần mỗi `playwright test` bởi `e2e/global-setup.ts` trên stack compose của `make up`,
  qua gateway ở `127.0.0.1:8080`. Trên cluster `svp` (`make k8s-e2e`), `global-setup` truyền `https://api.svp.localhost:8443` trong
  `SVP_E2E_GATEWAY_URL`, curl tin CA của cluster qua `CURL_CA_BUNDLE` (cho cả gateway lẫn storage), và `SVP_STACK=k3d` làm `lib.sh` đặt lại
  giới hạn ở Valkey của cluster, như `make k8s-smoke`.
  - Explore phải bắt đầu với ít nhất 21 video `READY` phát được, để feed có trang thứ ba và 20 lần chuyển video mỗi lần tới một video
    chưa phát trong lượt chạy. Chỉ chuỗi video từ đầu Explore mà master playlist trả 200 mới được tính, cho tới video đầu tiên không trả
    200: test đi feed từ video 0, và một video cũ có thể `READY` trong Postgres trong khi storage từng giữ file HLS của nó đã bị làm rỗng
    (volume object store bị xoá). Video của các lượt trước được tính; chỉ những video còn thiếu mới được upload, bởi các tác giả mới, mỗi
    tác giả tối đa `per_author`: lớp upload của gateway cho burst 10 mỗi user và tối đa 3 upload đang mở, nên mỗi upload chờ `READY`
    trước khi cái kế tiếp bắt đầu, và một 429 chờ `Retry-After` của nó.
  - Mỗi lượt chạy upload thêm một video của một tác giả mới có tiêu đề HTML (mô hình mối đe doạ WEB-1). Nó là video `READY` mới nhất, nên
    đứng đầu Explore, và tác giả của nó không có video nào khác: theo dõi họ làm feed Following có đúng video đó.
  - Ghi `{"xss": {"video_id", "author_id", "title"}, "explore_ready": N}` vào file mà đối số đầu tiên nêu.
  - **LOCAL LAB ONLY:** `source` `lib.sh` xoá các khoá rate limit đăng ký của gateway (`svp:gw:rl:register:*`) ở Valkey db 10 của
    stack (của cluster trên k3d) bằng `SCAN` + `DEL` qua `svp-valkey` của backend, như `make smoke`. BFF của web tới gateway từ một địa chỉ
    container, nên mọi trình duyệt của mọi lượt chạy dùng chung một bucket đăng ký (burst 20 mỗi giờ). Không trỏ nó vào stack dùng chung.
- **`make lighthouse`** (`lighthouse/run.sh`, chạy từ gốc repo trên stack compose của backend): ba lượt Lighthouse (`@lhci/cli`) cho mỗi
  trong hai trang, trong Chromium của Playwright, với cài đặt mobile mặc định của Lighthouse (điện thoại giả lập, 4G chậm mô phỏng và CPU
  chậm 4 lần; Lighthouse không có preset tên mobile, preset desktop của nó là cái còn lại):
  - feed, `/`, đã đăng nhập: một user mới, đăng ký ở gateway, đăng nhập qua trang login của web (`lighthouse/session.ts`) và Lighthouse
    gửi session cookie đó với mọi request (`extraHeaders`);
  - `/v/{id}` của một video `READY`, chưa đăng nhập: video mới nhất của Explore, hoặc, khi Explore rỗng, một clip thử 4 s mà user
    đăng trước.

  Sau đó là một bảng LCP, CLS, TBT và phần tử LCP của từng lượt, các lỗi console, và `lhci assert` theo ngưỡng của
  `lighthouse/lighthouserc.json`, mỗi ngưỡng kiểm trên trung vị của ba lượt của một trang. Giá trị ngưỡng và lý do của chúng ở
  [`AGENTS.md`](AGENTS.md). Báo cáo, HTML và JSON mỗi lượt cùng `manifest.json`, vào `test-results/lighthouse/` (gitignore); không upload đi đâu. Thoát với status của `lhci assert`.
  - Cookie không vào output và báo cáo: Lighthouse đọc nó từ một file riêng, bản chép mà mọi kết quả ghi lại
    (`configSettings.extraHeaders`) bị thay trước khi báo cáo được ghi, lượt chạy đỏ nếu vẫn tìm thấy giá trị cookie trong một kết quả
    hay báo cáo, và phiên được đăng xuất khi thoát để cookie ngừng dùng được.
  - **LOCAL LAB ONLY:** `source` `deploy/compose/lib.sh` của backend xoá các khoá rate limit đăng ký của gateway (`svp:gw:rl:register:*`)
    ở Valkey db 10 của stack bằng `SCAN` + `DEL` qua `svp-valkey` của backend, như `e2e/seed.sh` và `make smoke` của backend. Không trỏ nó vào stack dùng
    chung.

### Test e2e

Trên Linux (runner của CI), WebKit của Playwright là WebKitGTK, phát media qua GStreamer và tạm dừng pipeline của một `<video>` đang tắt
tiếng mà không nằm trong viewport. Một pipeline Media Source bị tạm dừng như vậy lỗi ở lần push kế tiếp ("Failed to push buffer",
`MEDIA_ERR_SRC_NOT_SUPPORTED`); hls.js đặt lại nó ba lần rồi bỏ cuộc, nên item kế được preload của feed, và đôi khi một item hiện tại
được tạo trước khi được bố cục, kết thúc ở `data-state="error"`. Safari, thứ mà các lượt này đứng thay, không có kiểu tạm dừng đó. Biến
`WEBKIT_GST_ALLOW_PLAYBACK_OF_INVISIBLE_VIDEOS` của WebKitGTK tắt nó, và `playwright.config.ts` đặt biến này cho WebKit. Playwright
truyền `env` cho trình duyệt thay vì `process.env`, nên cấu hình spread `process.env` vào đó. WebKit trên macOS bỏ qua biến này. Chi tiết
test e2e theo vùng code: [`docs/architecture.md`](docs/architecture.md#test-e2e).

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
- `scripts/contract.sh` có hai chế độ: `generate` ghi `gen/api.d.ts` (openapi-typescript) từ bản phát hành đã ghim; `check` sinh vào một
  thư mục tạm và đỏ, in diff, khi `gen/api.d.ts` khác; không ghi gì của cây làm việc. Layer OpenAPI tải về cũng phải băm ra digest mà manifest nêu. Bảng
  nguồn phát hành mà `cosign verify` đọc cũng là bảng Kyverno và mọi verifier cùng đọc. Script chạy từ `Makefile`, sau khi checkout
  `.backend/` (`scripts/backend.sh checkout`) và với Node, pnpm của repo này ở đầu `PATH`; cần docker (ORAS ghim, và cosign trừ khi đã có trên `PATH`), `jq` và mạng.

## Commit ghim của backend

`.backend-commit` là chỗ duy nhất ghim commit backend mà repo này dùng composite action của pipeline image (`.github/actions/image-leg`,
`image-index`, `image-sign`: build, quét, cổng, đẩy, gộp index, ký và attest SBOM, `vuln`, provenance), script CI (`deploy/ci/`: `plan.sh`,
luật file ngoại lệ, rescan, `ecr-copy.sh`, helper của job `promote`) và công cụ ghim digest trong `Makefile` của nó (cả `YQ_IMAGE` của bước promote). `make backend-checkout` đưa `.backend/` (gitignore) về đúng commit đó, chỉ tải khi commit
đổi; `.backend/` có thay đổi chưa commit thì dừng. Renovate theo dõi `main` của backend và mở PR nâng commit.

`scripts/backend.sh` là nơi đọc hai bản clone của backend (`anhnvcoder/svp-backend`) và commit backend mà stg chạy; repo này chỉ đọc chúng,
không bao giờ ghi:

| Lệnh | Việc |
| --- | --- |
| `backend.sh dir` | in thư mục backend mà e2e, các phép đo và việc tải source map dùng làm harness: stack compose và cluster `svp` mà nó chạy, `deploy/compose/lib.sh` và `deploy/k8s/lib.sh` (user, upload, đặt lại rate limit đăng ký), `.env` và `.k8s/ca.crt` của nó. Là `SVP_BACKEND_DIR` khi đặt (CI đặt nó tới checkout của bước đó); không thì `<workspace>/backend`, với `<workspace>` là nơi giữ checkout chính của repo này (thư mục cha của thư mục chứa common directory của git, giống nhau từ một worktree). Cây làm việc của nó được đọc như đang có; không clone, fetch hay chuyển nhánh ở đó. Thư mục không phải clone của backend thì lỗi và in lệnh tạo một bản: không bao giờ đọc bản khác thay vào |
| `backend.sh checkout` | đưa `.backend/` (gitignore) về checkout của backend ở commit của `.backend-commit`, chỗ duy nhất ghim nó: script `deploy/ci/` của nó (cổng quét, adapter nền tảng), các công cụ `Makefile` của nó ghim digest và bảng nguồn phát hành của nó (identity mà một contract được ký) đều đọc ở đó, giống nhau trên máy và trong CI. Checkout đã ở commit đó thì để nguyên (CI có thể tự checkout); commit khác thì fetch (chỉ commit đó, ẩn danh) rồi checkout detached. Từ chối thư mục có thay đổi chưa commit hay thư mục không phải clone của backend thay vì ghi đè |
| `backend.sh stg-revision` | in commit backend mà stg chạy, một SHA đầy đủ và không gì khác trên stdout: `revision` của `envs/stg/charts.yaml` trong bản clone `svp-gitops` (`anhnvcoder/svp-gitops`, cấu hình triển khai), là `SVP_GITOPS_DIR` khi đặt, không thì `<workspace>/gitops`. Cây làm việc của nó được đọc như đang có, như của backend: không clone, fetch hay chuyển nhánh ở đó, và thư mục không phải clone của `svp-gitops` thì lỗi và in lệnh tạo một bản |
| `backend.sh stg-check` | đỏ trừ khi backend của `backend.sh dir` đang ở commit đó và chạy được các bản phát hành của stg (`make up IMAGES=stg` ở đó): backend cũ hơn chế độ này bỏ qua `IMAGES` và build sáu service từ source, không phải backend mà stg chạy |

## Image

`Dockerfile` ở gốc repo, context là gốc repo (`.dockerignore` loại `node_modules`, output build, `.env*`, `.git`, `.backend/` và
công cụ của repo). Image chạy server standalone của Next trên Node distroless; source map trình duyệt không vào image, nằm ở stage
`sourcemaps` (`make sourcemaps`, `make k8s-sourcemaps` tải lên GlitchTip của stack local). Build, quét, ký image phát hành chạy trong CI
của repo này bằng composite action của backend ở `.backend-commit`; bản đã ký được chép cùng digest sang ECR stg (`deploy/ci/ecr-copy.sh` ở
commit ghim); promote lên stg là bước `yq` + `gh` của chính job `promote` (helper `yq_`, `promote_open_pr`, `promote_image_row` của
`deploy/ci/common.sh` ở commit ghim).

Build image:

```sh
env -u DOCKER_DEFAULT_PLATFORM docker build -t svp/web:dev .
```

Không bí mật nào và không cài đặt lúc chạy nào vào build: `GATEWAY_URL`, `REDIS_URL`, `APP_ORIGIN`, `MEDIA_ORIGIN`, `UPLOAD_ORIGIN`,
`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` và các biến `OTEL_*` của SDK OpenTelemetry được server đọc khi
khởi động hoặc khi một request cần, nên một image chạy được ở compose và ở cluster. Build argument duy nhất, `SVP_BUILD_ID`, là id của
bản build, không phải cài đặt. Source map của bundle trình duyệt được lấy ra từ cùng bản build, vào stage `sourcemaps`:

```sh
env -u DOCKER_DEFAULT_PLATFORM docker build --target sourcemaps --output type=local,dest=<thư mục> .
```

Cách stage build xử lý source map: `next build` ghi một map cạnh mỗi chunk và stylesheet của trình duyệt, mỗi file kết thúc bằng một
comment `sourceMappingURL` nêu map của nó (một tên băm riêng), và map của các bundle server trong cây standalone. Một map được phục vụ
sẽ công bố toàn bộ source của client, nên:

- mọi map của `.next/static` được chuyển tới `/sourcemaps/_next/static` (đường mà trình duyệt tải chunk), cùng một bản chép của mỗi chunk
  JavaScript nêu một map: chunk như lúc build, có comment ghép nó với map của nó cho việc upload (`make sourcemaps`), và có debug id
  đúng là cái mà chunk được phục vụ mang;
- các chunk và stylesheet được phục vụ mất comment đó (một map "hidden": bundle không nêu map nào), vốn là dòng cuối của chúng, nên mọi
  dòng và cột khác, và comment debug id, vẫn là cái map mô tả;
- map của server bị xoá.

Các bước kiểm sau đó làm build đỏ khi còn một map, hay chữ `sourceMappingURL` ở bất kỳ dạng nào, sót lại cho stage runtime. Build và các
bước chuyển chỉ là hai bước của stage này: stage runtime ở dưới chép kết quả, không bao giờ chép các layer, nên không map nào vào image.

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

`.grype.yaml` liệt kê các lỗ hổng mà grype bỏ khỏi lượt quét SBOM của image web (bước grype của composite action `image-leg` của backend,
chạy từ `.backend/` bởi `images.yml`). grype đọc nguyên file (`-c`), nên file chỉ chứa các rule dạng:

```yaml
- vulnerability: <id>
  include-aliases: true
  package:
    name: <tên của purl, mọi ký tự đặc biệt của regex được escape bằng \>
    version: <version>
```

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
    seed e2e và Lighthouse (khoá đăng ký ở Valkey db 10) chỉ chạm Valkey của stack compose của chính lượt này (Kafka, Valkey và Postgres
    đều là container của stack, job không có service container nào). Công cụ của script lấy từ kho
    Ubuntu (không action bên thứ ba): `ffmpeg` cho video thử, `jq`; `curl` và `openssl` có sẵn trong image runner.
  - `sarif`: job duy nhất có quyền ghi (`security-events: write`); finding của PR nằm ở artifact và tóm tắt job. Job checkout chỉ để
    `upload-sarif` đọc dòng của từng finding và tính fingerprint (alert qua được việc lệch dòng cùng lịch sử và việc dismiss), không chạy gì
    của repo. Là báo cáo chứ không phải check: upload lỗi vẫn làm lượt chạy đỏ.
- `images.yml` (PR, push `main`, chạy tay, lịch hằng ngày): `plan`; PR chỉ `build-nopush` (build, quét hai chân amd64, arm64); `main`:
  `build` (trivy chặn bí mật và CRITICAL còn lại sau `.trivyignore.yaml`, grype trên SBOM chặn Critical còn lại sau `.grype.yaml`,
  rồi mới push), `merge` (index đa kiến trúc), `sign` (cosign keyless:
  chữ ký, SBOM, attestation `vuln` ở dạng Sigstore bundle; rồi build provenance bằng `actions/attest`, quyền `attestations: write` chỉ ở
  job này), `ecr-copy` (chép bản đã ký cùng mọi referrer sang ECR stg rồi kiểm lại ở đó), `promote` (environment `promote`, token một giờ
  của GitHub App `svp-web-promoter` chỉ
  trên `svp-gitops`: clone `svp-gitops`, dựng nhánh `bot/promote-stg-web` một commit của bot trên `main`, `yq_ -i` (yq theo
  `YQ_IMAGE` ghim digest trong `Makefile` của backend ở `.backend-commit`, không mạng) đúng khối `image` của
  `envs/stg/images/web.yaml` (không bao giờ `envs/stg/charts.yaml`), từ chối commit cũ hơn bản web mà `main` hay PR đang mở ghi (so tổ
  tiên), push `--force-with-lease`, `gh pr create`/`edit`, `gh pr merge --auto --squash --match-head-commit`: PR tự merge khi
  `gitops-ok` xanh), `rescan`
  (lịch hằng ngày: quét lại và attest lại bản web của repo này đang ở `envs/*/images/`, không đụng bản của backend, rồi làm mới bản sao ở
  ECR), `sarif`, check tổng `images-ok`.
  - Luồng: image `ghcr.io/anhnvcoder/svp-frontend/web` build mỗi lượt từ cả cây trên runner amd64 và arm64 gốc; image cục bộ quét bằng trivy và
    SBOM bằng grype, chặn bí mật và CRITICAL **trước** khi đẩy gì; chỉ đẩy đúng cái đã quét, rồi ghép index đa kiến trúc, ký keyless bằng cosign,
    attest SBOM (syft) và kết quả quét, sau đó build provenance (`actions/attest`), tất cả là Sigstore bundle; digest đã ký được chép sang ECR
    stg, kiểm lại ở đó, rồi mới được promote lên stg qua PR ở `svp-gitops`; digest đã phát hành được quét lại hằng ngày, cả bản sao ở ECR. Lý do
    dùng ECR và role CI: [ADR-0062](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0062-ecr-registry-ci-oidc.md).

    ```mermaid
    flowchart LR
      build["build, merge"] -->|push theo digest| ghcr[("GHCR")]
      sign -->|"chữ ký, SBOM, vuln, provenance"| ghcr
      ghcr -->|"ecr-copy: ecr-copy.sh copy"| ecr[("ECR stg")]
      ecr -->|"verify đạt: artifact ecr-web"| promote
      promote -->|"PR bot/promote-stg-web"| gitops["svp-gitops envs/stg"]
      rescan -->|"vuln mới"| ghcr
      rescan -->|"ecr-copy.sh refresh"| ecrs[("ECR của env nêu digest")]
    ```

  - Một lần ghim cho cả bộ: action, guard của chúng (`deploy/ci/image-guard.sh` cạnh chúng) và image công cụ mà `Makefile` của backend ghim digest
    đi cùng `.backend-commit`. Input `code-root`, và `SVP_CODE_ROOT` cho script backend mà file này chạy (`deploy/ci/plan.sh`,
    `deploy/ci/rescan.sh`), báo rằng code được build và phát hành là checkout này chứ không phải của backend: chúng lấy nguồn phát hành có
    repository là repo này (`deploy/helm/svp-policy/files/sources.json` của `.backend/`), đẩy dưới prefix của nó, ký bằng identity của nó và từ
    chối chạy khi HEAD ở đây không là commit của lượt. Bước của composite action chạy trong job gọi nó, nên chứng chỉ keyless và build
    provenance mang tên workflow này, identity của nguồn `web`. Workflow chỉ nối job, quyền và artifact; ngoại lệ là job `promote`, có bước viết
    ngay ở đây, dùng ba helper của `deploy/ci/common.sh` ở backend: `yq_`, `promote_open_pr`, `promote_image_row`.
  - Quyền: chỉ job `promote` ghi vào repo khác. Environment `promote` (nhánh triển khai chỉ `main`) giữ khoá GitHub App `svp-web-promoter` cài
    riêng trên `svp-gitops`; job đổi khoá thành token một giờ cho `svp-gitops` với quyền `contents` và `pull-requests` write, thu hồi khi job kết
    thúc; `GITHUB_TOKEN` chỉ đọc repo này; không `id-token`, không `packages`. Không job PR nào gọi environment đó hay đọc secret. Role AWS đi
    qua OIDC của GitHub (`aws-actions/configure-aws-credentials`, phiên một giờ): `ecr-copy` nhận `svp-ci-ecr-release-frontend` của account stg
    (trust chỉ `ref:refs/heads/main` của repo này), `rescan` nhận `svp-ci-ecr-rescan-frontend` của stg và prd (trust chỉ environment
    `ecr-rescan`, nhánh `main`, không người duyệt vì chạy theo lịch); mỗi role chỉ đẩy (rescan: thêm xoá) repo ECR `svp-frontend/web`. Account ID
    đến từ secret `SVP_AWS_STG_ACCOUNT_ID`, `SVP_AWS_PRD_ACCOUNT_ID` nên bị che trong log; thiếu secret thì job đỏ, nêu tên nó. Chỉ dùng action
    của GitHub, `sigstore/cosign-installer`, `aws-actions/configure-aws-credentials` và composite action của backend dưới
    `.backend/.github/actions/` (ghim bởi `.backend-commit`; chúng chỉ gọi action của GitHub ở SHA chúng ghim). Không job nào đẩy vào repo này
    nên checkout không giữ token.
  - `sign`: chữ ký keyless trên digest của index, attestation SBOM trên từng manifest, attestation `vuln` (cả hai lượt quét) trên index, với cosign
    mà `Makefile` của backend ghim; rồi build provenance (SLSA v1, `actions/attest` dựng từ claim của token OIDC của lượt) trên index, sau chữ ký và
    attestation `vuln` (action `image-sign`). Action từ chối ký trừ khi workflow của lượt là subject của nguồn phát hành của repo này (`images.yml`
    ở `refs/heads/main`, identity mà Kyverno nhận cho `web` từ đây), và chỉ ghi mỗi bundle khi digest chưa có bundle cùng loại (chạy lại một lượt
    không ký hai lần). Đây là job duy nhất có `attestations: write` (provenance cũng vào attestations của repo); `id-token: write` chỉ ở job
    này, `ecr-copy` và `rescan`; không dùng cache. Artifact `release-<image>` (repository, tag, digest của index đã ký) là đầu vào của
    `ecr-copy`.
  - `ecr-copy` (matrix theo image, `fail-fast: false`): `deploy/ci/ecr-copy.sh copy` của backend chép index, mọi manifest con và mọi referrer
    (chữ ký, SBOM, `vuln`, provenance) từ GHCR sang repo cùng tên ở ECR stg, cùng digest, không build lại; chạy lại bao nhiêu lần cũng được
    (chép nốt phần thiếu), rồi kiểm chữ ký và attestation trên bản ECR với identity của nguồn `web`. Chỉ khi kiểm đạt job mới tải lên artifact
    `ecr-<image>` (cùng nội dung `release-<image>`), là thứ `promote` ghi vào `envs/stg/images/` của `svp-gitops`. `vuln` ở ECR quá hạn thì
    job đỏ và in lệnh dispatch rescan cho digest đó (mục `rescan`).
  - `promote`: dựng lại nhánh `bot/promote-stg-web` thành một commit của bot trên `main` ở đó, đặt khối `image` của `envs/stg/images/web.yaml` về
    bản lượt này vừa ký (comment của file giữ nguyên), mở hay cập nhật PR và bật auto-merge; `svp-gitops` merge khi `gitops-ok` xanh, không cần
    duyệt (không Code Owner nào giữ `envs/stg/`). Không bao giờ ghi `envs/stg/charts.yaml`: chart là của backend. Job chạy cả khi bước ký hay
    `ecr-copy` lỗi, khi đó không có artifact `ecr-web` và không promote gì; chạy lại leg lỗi rồi chạy lại `promote` thì đi tiếp. Các lượt
    của `main` nối đuôi nhau (nhóm concurrency của build không bao giờ huỷ) nên lượt sau không promote trước
    lượt trước; bước từ chối lượt có commit cũ hơn bản `web` mà `main` của `svp-gitops` hay PR đang mở nêu (lượt chạy lại, dispatch một commit cũ),
    so bằng quan hệ tổ tiên chứ không bằng thời gian. `yq_` là yq của `YQ_IMAGE` (ghim digest trong `Makefile` của backend, không mạng): yq cài
    sẵn trên runner đổi theo image runner mà không ai thấy, trong khi bước này ghi vào repo triển khai. `promote_open_pr` tìm PR đang mở của app
    từ một nhánh, không bao giờ của fork; `gh` lỗi hay danh sách dài quá mức tin được thì lỗi. `promote_image_row` là dòng của bảng ở body PR.
    `source` file đó chỉ định nghĩa hàm, không chạy gì.
  - `rescan` (lịch hằng ngày, hay dispatch với `rescan=true`): mỗi digest `web` của repo này mà `svp-gitops` nêu (`envs/*/images/` ở `main`, ở PR
    đang mở `bot/promote-stg-web` và ở PR promote prd đang mở của backend) được quét lại theo từng manifest; attestation `vuln` được thay bằng
    kết quả thật, ký bằng identity của workflow này (theo định dạng mà digest được ký; với Sigstore bundle thì các bundle `vuln` cũ bị gỡ, cần
    `packages: write`). CRITICAL được ghi lại trước rồi mới làm job đỏ (mail cho chủ repo); bí mật làm job đỏ trước khi attest gì
    (`deploy/ci/rescan.sh`). Bản của backend để rescan của backend lo: `--source web` làm script kiểm lượt này đúng là của nguồn phát hành của
    repo này và workflow ký của nó trước khi đọc gì, nên không bao giờ thay attestation của bản phát hành repo khác. Sau đó bản sao của digest ở
    ECR của mỗi env mà `svp-gitops` nêu nó (`envs/<env>/`) nhận `vuln` mới, `vuln` cũ ở đó bị gỡ (`ecr-copy.sh refresh`, role rescan của account
    env đó; environment `ecr-rescan`). Dispatch với `rescan=true`, `image=web`, `digest=<sha256:…>` và `env` (`stg` mặc định, `prd`) làm mới một
    bản chưa được promote (ECR stg: `ecr-copy` lỗi vì `vuln` quá hạn; ECR prd: `promote-prd` của backend dừng giữa chừng): quét lại digest đó
    trên GHCR, làm mới bản ở ECR của `env` (với `stg`: chép thêm phần còn thiếu), rồi chạy lại job `ecr-copy` và `promote` của lượt build đó (hay
    `promote-prd`). Rollback `web` về một digest cũ hơn hạn của `vuln` (`maxAttestationAge` của `svp-policy`): trước khi sync, dispatch với
    `rescan=true` và `values_ref=<nhánh, SHA hay refs/pull/<n>/head của svp-gitops>`
    (`gh workflow run images.yml --repo anhnvcoder/svp-frontend --ref main -f rescan=true -f values_ref=<ref>`); lượt quét thêm mọi digest `web`
    mà `envs/<env>/images/` ở ref đó nêu và làm mới bản của nó ở ECR của `<env>`. `values_ref` không đi cùng `digest`, `image`, `env`, chỉ đi với
    `rescan=true`; sai thì job `plan` lỗi. `svp-gitops` được clone ẩn danh và file của nó chỉ đọc như dữ liệu, không chạy; `GITHUB_TOKEN` chỉ để
    hỏi PR promote có đang mở không (đọc repo public). Không cache vì job giữ `id-token`.
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
