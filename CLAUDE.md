# svp-web — web client của lab short-video-platform

Đọc trước khi làm bất cứ việc gì: [`README.md`](README.md) (lệnh, hợp đồng API, commit ghim của backend),
[ADR-0016](https://github.com/anhnvcoder/short-video-platform/blob/main/docs/adr/0016-web-client.md) (thiết kế web client, danh sách gói
ở §10) và [ADR-0033](https://github.com/anhnvcoder/short-video-platform/blob/main/docs/adr/0033-svp-web-repo.md) (tách repo, hợp đồng,
nguồn phát hành). Thiết kế và quyết định chung của lab nằm ở `docs/` của backend; đổi một quyết định đã chốt thì đề xuất kèm ADR ở đó.

## Quy ước

- **Ngôn ngữ lập trình:** TypeScript (Next.js); chỉ dùng gói trong danh sách của ADR-0016 §10, thêm gói phải có lý do và người học duyệt.
  Version gói ghim chính xác, `pnpm install --frozen-lockfile`; setting chuỗi cung ứng ở `pnpm-workspace.yaml`.
- **Ngôn ngữ viết:** file `.md` viết tiếng Việt; mọi thứ trong code (comment, log, tên test, error message, file cấu hình) viết tiếng
  Anh.
- **Comment trong code** tự đủ nghĩa: nói lý do ngay tại chỗ, không nhắc ADR (số mục đổi hay ADR bị thay thì tham chiếu thành sai). File
  `.md` vẫn link ADR.
- **Hợp đồng API:** type của gateway chỉ sinh từ bản phát hành mà `api/contract.json` ghim (`make generate`); không sửa tay
  `gen/api.d.ts`, không chép spec của backend vào đây. Cần thay đổi API thì thay đổi ở backend trước (theo luật version của spec), rồi
  nâng bản ghim ở đây.
- **Script của backend:** `.backend-commit` là chỗ duy nhất ghim commit backend; `.backend/` là bản checkout ở commit đó, không sửa
  gì trong đó. Harness của stack (compose, cluster, xoá khoá rate limit) đọc từ bản clone backend của workspace (`SVP_BACKEND_DIR`,
  mặc định `<workspace>/backend`); không chép script nào giữa hai repo.
- **Docker** chạy với tiền tố `env -u DOCKER_DEFAULT_PLATFORM` (shell global đặt `linux/amd64` cho dự án khác; image phải đúng kiến
  trúc máy). Stack compose và cluster k3d chỉ dựng bằng `Makefile` của backend.
- **Git:** conventional commits, mô tả tiếng Việt. Không commit `.env`, secret, token. Mọi thay đổi vào `main` đi qua PR có `ci-ok`
  và `images-ok` xanh; không force push, hoàn tác bằng PR revert.

## Kiểm tra

- `make install`, rồi `make check` (lint, Prettier, typecheck, Vitest, build, server standalone, ngân sách bundle),
  `make generate-check` (bản sinh khớp hợp đồng đã ghim), `make lockfile-scan` (cổng lỗ hổng của lockfile).
- Test e2e, đo, Lighthouse, source map (`make e2e`, `make measure-web`, `make measure-upload`, `make lighthouse`, `make sourcemaps`,
  `make k8s-e2e`, `make k8s-sourcemaps`) cần stack của backend đang chạy; máy 16 GB: không chạy compose và k3d cùng lúc.

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
cloud" của `CLAUDE.md` backend.
