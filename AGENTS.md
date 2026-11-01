# svp-frontend — web client của lab short-video-platform: hướng dẫn cho agent

File này theo định dạng [AGENTS.md](https://agents.md): luật làm việc cho mọi agent.

Đọc trước khi làm bất cứ việc gì: [`README.md`](README.md) (lệnh, hợp đồng API, commit ghim của backend),
[ADR-0016](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0016-web-client.md) (thiết kế web client, danh sách gói
ở §10) và [ADR-0033](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0033-svp-web-repo.md) (tách repo, hợp đồng,
nguồn phát hành). Thiết kế và quyết định chung của lab nằm ở `docs/` của backend; đổi một quyết định đã chốt thì đề xuất kèm ADR ở đó.

## Quy ước

Quy ước chung (ngôn ngữ, tài liệu timeless, ADR, comment, Git, repo public, phụ thuộc): [`CONTRIBUTING.md` của `anhnvcoder/.github`](https://github.com/anhnvcoder/.github/blob/main/CONTRIBUTING.md); dưới đây chỉ luật riêng của repo này.

- **Ngôn ngữ lập trình:** TypeScript (Next.js); chỉ dùng gói trong danh sách của ADR-0016 §10, thêm gói phải có lý do và người học duyệt.
  Version gói ghim chính xác, `pnpm install --frozen-lockfile`; setting chuỗi cung ứng ở `pnpm-workspace.yaml`.
- **Ngôn ngữ viết:** file `.md` viết tiếng Việt; file `.md` vẫn link ADR.
- **Hợp đồng API:** type của gateway chỉ sinh từ bản phát hành mà `api/contract.json` ghim (`make generate`); không sửa tay
  `gen/api.d.ts`, không chép spec của backend vào đây. Cần thay đổi API thì thay đổi ở backend trước (theo luật version của spec), rồi
  nâng bản ghim ở đây.
- **Script của backend:** `.backend-commit` là chỗ duy nhất ghim commit backend; `.backend/` là bản checkout ở commit đó, không sửa
  gì trong đó. Harness của stack (compose, cluster, xoá khoá rate limit) đọc từ bản clone backend của workspace (`SVP_BACKEND_DIR`,
  mặc định `<workspace>/backend`); không chép script nào giữa hai repo. Riêng job `promote` của `images.yml` không chạy script backend nào:
  bước của nó viết ngay trong workflow, chỉ source `.backend/deploy/ci/common.sh` để dùng `yq_` (yq theo `YQ_IMAGE` ghim digest trong
  `Makefile` của backend), `promote_open_pr` và `promote_image_row`, rồi chỉ ghi khối `image` của `envs/stg/images/web.yaml` trên nhánh `bot/promote-stg-web`
  của `svp-gitops` và bật auto-merge cho PR. Build provenance của job `sign` cũng không phải script: bước `actions/attest` (ghim cùng SHA
  với `images.yml` của backend) attest digest index mà `sign-image.sh` trả ra, sau chữ ký và `vuln`.
- **Docker** chạy với tiền tố `env -u DOCKER_DEFAULT_PLATFORM` (shell global đặt `linux/amd64` cho dự án khác; image phải đúng kiến
  trúc máy). Stack compose và cluster k3d chỉ dựng bằng `Makefile` của backend.
- **Renovate** (`renovate.json`, sáng thứ Bảy, `minimumReleaseAge` 3 ngày trừ cảnh báo lỗ hổng): chỉ `patch` của npm `devDependencies`
  chạy trên máy dev và CI tự merge (auto-merge của GitHub, squash) khi `ci-ok`, `images-ok` xanh; npm `dependencies`, `typescript`,
  `tailwindcss`, `@tailwindcss/postcss` (chạy trong `next build`, output vào image), pnpm, Node cùng mọi digest của base image trong
  `Dockerfile` (Node minor, patch đến dưới dạng digest), image của workflow, công cụ ghim trong `Makefile`, action, `.backend-commit`,
  `api/contract.json`, minor, major giữ duyệt tay ([ADR-0041](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0041-github-hardening.md) (i)).
  Luật tự merge không được chạm đường có chủ trong `CODEOWNERS`.
- **Git:** mọi thay đổi vào `main` đi qua PR có `ci-ok` và `images-ok` xanh; tiêu đề PR (thành tiêu đề commit squash) theo Conventional
  Commits, check `pr-title` của `pr-title.yml` kiểm.

## Kiểm tra

- `make install`, rồi `make check` (lint, Prettier, typecheck, Vitest, build, server standalone, ngân sách bundle),
  `make generate-check` (bản sinh khớp hợp đồng đã ghim), `make lockfile-scan` (cổng lỗ hổng của lockfile).
- Test e2e, đo, Lighthouse, source map (`make e2e`, `make measure-web`, `make measure-upload`, `make lighthouse`, `make sourcemaps`,
  `make k8s-e2e`, `make k8s-sourcemaps`) cần stack của backend đang chạy; máy 16 GB: không chạy compose và k3d cùng lúc.
- CI chạy lại trên máy: job `check` là ba lệnh đầu cộng `make lockfile-scan`; job `config` là `make backend-checkout`, rồi
  `SVP_CODE_ROOT="$PWD" .backend/deploy/ci/scan-gate.sh --check-ignorefile` và
  `actionlint` (`make tools` cài); job `zizmor` là `make zizmor` (trên máy chỉ offline, không truyền token vào container).

## Quy ước test

- Vitest (`make check`): test Redis theo mục "An toàn database" dưới đây; request mạng không có handler MSW thì test lỗi.
- e2e (`e2e/*.e2e.ts`, Playwright): chỉ chạy trên stack compose (`make e2e`) hay cluster k3d (`make k8s-e2e`) của backend, chọn bằng
  `SVP_STACK` (`compose` mặc định, `k3d`); mỗi lượt đăng ký user mới với handle ngẫu nhiên dạng người chọn (`e2e/fixtures.ts`), tác giả
  do seed tạo có handle sinh `u_…`. Test làm video `READY` (gắn `@publishes`) chạy ở project `chromium-publishing`/`webkit-publishing`
  sau hai project chính. `SVP_E2E_EVIDENCE=<thư mục tuyệt đối>` bật trace, video, ảnh toàn trang (`e2e/evidence.e2e.ts`) vào thư mục
  đó; `SVP_E2E_GLITCHTIP=1` thêm `e2e/glitchtip.e2e.ts` (cần tải source map trước). Kết quả và số đo ở `test-results/` (gitignore).

## An toàn database

Chỉ dùng Redis local `127.0.0.1:6379`, luôn ghi rõ port (`redis-cli -p 6379 -n 15`):

| Dùng cho                    | Redis db |
| --------------------------- | -------- |
| session của `make dev`      | 9        |
| test (`make check`, Vitest) | 15       |

- Test Redis đọc `SVP_TEST_REDIS_URL` (`make check` đặt `redis://127.0.0.1:6379/15`); helper `server/testing/redis.ts` chỉ nhận db 15
  của `127.0.0.1:6379` hay `localhost:6379`, mỗi test một tiền tố khoá ngẫu nhiên `svp:test:<hex>:` và chỉ xoá khoá của tiền tố đó;
  thiếu biến thì nhóm test Redis bị bỏ qua. Request mạng không có handler MSW thì test lỗi.
- Không `FLUSHDB`/`FLUSHALL`, kể cả ở db 15. Redis db 0, 5 và 7 chứa dữ liệu của dự án khác: không dùng.
- **LOCAL LAB ONLY:** e2e và Lighthouse xoá khoá `svp:gw:rl:register:*` ở db 10 (gateway của stack compose) hay Valkey db 10 của cluster,
  bằng `SCAN` + `DEL` qua script của backend; không trỏ chúng vào stack dùng chung.
- Không có database nào khác: web không đọc Postgres; dữ liệu đi qua gateway.

## An toàn cloud

AI không chạy lệnh nào chạm tài khoản AWS/GCP hay cluster cloud, kể cả lệnh chỉ đọc; soạn lệnh để người học tự chạy, như mục "An toàn
cloud và chuỗi cung ứng" của `AGENTS.md` backend.
