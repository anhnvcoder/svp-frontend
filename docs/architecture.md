# Kiến trúc web client

Trang này giải thích **vì sao** code TypeScript của web client viết như hiện tại, theo từng vùng của code. Thiết kế chung của lab
(khối, luồng giữa các service, mô hình mối đe doạ) ở `docs/` của backend; trang này không chép lại. Quyết định và danh sách gói của web
client: [ADR-0016](https://github.com/anhnvcoder/svp-backend/blob/main/docs/adr/0016-web-client.md). Lệnh chạy, kiểm và phát hành: [`README.md`](../README.md).

## Mục lục

- [Phiên và làm mới access token](#phiên-và-làm-mới-access-token)
- [Feed](#feed)
- [Tên hiển thị (quy tắc kiểm ở trình duyệt)](#tên-hiển-thị-quy-tắc-kiểm-ở-trình-duyệt)
- [Danh sách video của tôi (khi nào hỏi lại)](#danh-sách-video-của-tôi-khi-nào-hỏi-lại)
- [Bản thiết kế của các màn hình](#bản-thiết-kế-của-các-màn-hình)
- [Số đo trình duyệt (web vitals)](#số-đo-trình-duyệt-web-vitals)
- [Lọc dữ liệu cá nhân trước khi gửi lên GlitchTip](#lọc-dữ-liệu-cá-nhân-trước-khi-gửi-lên-glitchtip)
- [Trace và số đo của server web (OpenTelemetry)](#trace-và-số-đo-của-server-web-opentelemetry)
- [Server: OpenTelemetry và standalone output](#server-opentelemetry-và-standalone-output)
- [i18n: thông điệp biên dịch lúc build](#i18n-thông-điệp-biên-dịch-lúc-build)
- [Source map và GlitchTip](#source-map-và-glitchtip)
- [Test e2e](#test-e2e)

## Phiên và làm mới access token

`server/session-access.ts` cấp access token dùng được cho một phiên, và làm mới nó trước khi hết hạn một khoảng ngắn.

Refresh token chỉ dùng được một lần: đưa nó lần thứ hai thì gateway thu hồi cả họ token và người dùng bị đăng xuất. Vì vậy ở bất kỳ
đâu, mỗi phiên chỉ được có nhiều nhất một lần làm mới đang chạy:

- các request trong cùng một process dùng chung một promise;
- các process (replica) dùng chung một lease ở Redis; request không giữ lease thì chờ phiên mới thay vì tự làm mới.

Lời gọi của người giữ lease tới gateway, kể cả phần chờ câu trả lời, bị cắt trước khi lease hết một khoảng đệm: một lời gọi còn chờ
quá mốc đó sẽ chồng lên lời gọi của người giữ lease kế tiếp, mà người này đưa cùng một token.

Khi chưa biết kết quả của một lần làm mới (timeout, 5xx, mất câu trả lời), phiên được giữ và request này không thử lại: gateway có thể
đã xoay token rồi, nên thử lại là phát lại token cũ. Request kế tiếp thử lại với token đang có. Nếu token thực ra đã bị xoay, gateway
thấy token bị phát lại, thu hồi cả họ, trả 401 và phiên kết thúc. Cái giá là một lần đăng nhập lại trong trường hợp hiếm là mạng lỗi
đúng lúc đó; đổi lại vẫn phát hiện được việc phát lại token mà không cần cửa sổ chồng lấn nào. Trong lúc chờ, access token cũ vẫn được
dùng khi còn hạn; hết hạn thì request đó coi như đã đăng xuất, và phiên không bị xoá.

## Feed

### Trang đầu nằm trong HTML

Hai trang feed render ở server (`features/feed/feed-route.tsx`). Trang đầu của feed nằm trong HTML của trang, không stream vào sau một
skeleton. Lý do: poster đầu tiên của nó là phần vẽ lớn nhất của trang, và React hiện nội dung được stream vào một ranh giới Suspense
theo từng đợt, cách đợt trước tới khoảng 300 ms, nên phần vẽ đó sẽ phải chờ trong lúc script của trang tải và chạy.

Vì vậy HTML chờ trang đầu, tối đa bằng timeout của gateway (`server/feed.ts`). Không có trang thì client tự lấy nó sau skeleton. Đổi tab
vẫn trả lời ngay: màn hình feed phủ skeleton lên tab cũ trong lúc router chờ tab mới (`feed-screen.tsx`).

### Một feed, từng trang theo `next_cursor`

`features/feed/use-feed.ts` giữ một feed, tải từng trang theo `next_cursor`. Server render trang đầu rồi đưa xuống dưới dạng
`initialPage`, đóng dấu thời điểm gateway trả nó (`fetchedAt`); các trang sau lấy từ `/api/feed/<kind>`.

- **Không tải lại ngầm.** Feed không bị tải lại sau lưng người dùng (khi cửa sổ lấy lại focus, khi mạng nối lại): làm vậy sẽ tải lại mọi
  trang và dời danh sách dưới video đang xem.
- **Bỏ khỏi cache ngay khi rời màn hình** (`gcTime` 0). Trang là dynamic nên mỗi lần vào đều render một trang đầu mới ở server, mà
  `initialData` chỉ gieo vào cache đang rỗng; một feed được giữ lại sẽ che trang mới hơn (like đã làm từ đó, video mới) sau trang cũ. Không
  giữ feed thì trang của server luôn là trang được hiện.
- **Back/Forward.** Trình duyệt Back/Forward không render lại trang: router phát lại payload nó đã giữ từ lần vào đầu, nên trang đưa
  xuống có thể cũ, thậm chí cũ một giây mà trên đó đã có một like. Trang như vậy mang một dấu mà tab này đã hiện rồi: nó bắt đầu ở
  trạng thái stale, và React Query tải lại trang đầu ngầm, thay trang cũ. Dấu chưa thấy bao giờ là một lần render mới của server: nó
  tính là còn mới từ lúc mount, nên không bị hỏi hai lần. Back có thể đến trước khi timer của React Query bỏ feed mà màn hình vừa rời
  (vài ms sau một lần đổi tab): màn hình khi đó đọc feed ấy, vẫn còn mới, và `initialData` không áp dụng; vì vậy một lần phát lại luôn
  tải khi mount, cache đang giữ gì cũng vậy.
- **`enabled` false giữ request đầu.** Server đã được báo chờ (429) và client chờ nốt phần còn lại.

### Player

`features/feed/player-pool.ts`:

- **Không đặt poster cho `<video>`.** `<img>` của chính item, nằm dưới host, hiện thumbnail cho tới khung hình đầu, và một `<video>` chưa
  có khung hình thì không vẽ gì đè lên nó. Poster ở đây sẽ vẽ cùng ảnh đó lần nữa, bên trên; mà `<img>` có thể vẽ muộn, ở khung hình
  đầu sau tác vụ dài của hydration, chính là tác vụ chuyển `<video>` này vào. Khi đó cả hai vẽ trong cùng một khung hình, cùng kích
  thước, và trình duyệt báo `<video>` là phần vẽ lớn nhất của trang, một phần tử chỉ tồn tại sau khi script của trang đã chạy.
- **Với hls.js, chỉ phát khi phần tử đã phát được** (sự kiện `canplay` gọi lại hàm này). Phát khi chưa có dữ liệu làm phần tử chờ ở 0
  s trong lúc segment đầu bắt đầu muộn hơn một chút (0,07 s với MPEG-TS của media worker), nên hls.js phải seek qua khoảng trống đó
  ngay trong lúc phát; WebKit trên Linux (GStreamer) khi máy bận khi đó không bao giờ kết thúc cú seek, và video kẹt ở trạng thái đệm
  dù đã có dữ liệu. hls.js tải segment mà không cần `play()`; player HLS riêng của trình duyệt (không có MediaSource) thì không, nên
  với nó thì gọi phát ngay.

## Tên hiển thị (quy tắc kiểm ở trình duyệt)

`features/profile/display-name.ts` lặp lại quy tắc của user-service từng ký tự một (`normalizeDisplayName` trong
`services/user-service/internal/server/profile.go` của backend). User-service vẫn là nơi quyết định; phía web chỉ trả lời sớm. Bị từ
chối:

- ký tự điều khiển (Cc), làm ngắt dòng trong giao diện, và dấu ngăn dòng, ngăn đoạn U+2028, U+2029;
- ký tự định dạng (Cf): các ký tự điều khiển bidi sẽ đảo thứ tự `@handle` và thời gian hiện sau tên (WEB-18), và các ký tự vô hình như
  U+200B, U+2060, U+FEFF, dấu gạch nối mềm và các tag character;
- mọi code point default-ignorable khác (các ký tự đệm Hangul U+115F, U+1160, U+3164, U+FFA0, combining grapheme joiner U+034F) và mẫu
  chấm nổi Braille trống U+2800: chúng không hiện gì, nên một tên trông như rỗng sẽ qua được bước trim;
- một surrogate lẻ, vốn không phải văn bản (user-service từ chối UTF-8 không hợp lệ).

Bảng ký tự của web là bảng theo phiên bản Unicode của trình duyệt, của user-service là bảng của Go: một code point mới ở một bên có thể
bị đánh giá khác nhau, và khi đó câu trả lời của user-service (`INVALID_DISPLAY_NAME`) là câu được hiện.

## Danh sách video của tôi (khi nào hỏi lại)

`features/profile/use-video-pages.ts` quyết định danh sách "My videos" có còn đổi một mình hay không, tức là có đáng hỏi lại hay không.
Danh sách còn đổi khi có:

- một video `PROCESSING`: nó thành `READY` hay `FAILED` trong vài phút;
- một video `UPLOADING` mà tab này đang tải lên (`awaitedIds`): nó thành `PROCESSING` khi file lên xong. Tab giữ id từ lúc có form cho
  tới khi xử lý xong, nên một danh sách hỏi ngay sau khi hoàn tất, có thể vẫn còn ghi `UPLOADING`, sẽ được hỏi lại;
- một video `UPLOADING` khác (tab hay thiết bị khác): nó vẫn có thể được gửi lên chừng nào form của nó còn dùng được, tính từ
  `created_at`. Sau đó nó đã bị bỏ (huỷ, đóng tab, form bị thay) và hỏi mỗi 5 giây cho tới khi job dọn dẹp xử lý nó sẽ kéo dài cả giờ.
  `created_at` là đồng hồ của server còn `now` là của trình duyệt: đồng hồ lệch vài phút chỉ làm dời lúc ngừng hỏi;
- một video mà tab này tải lên nhưng các trang đã tải chưa có.

"My videos" hỏi lại mỗi `refreshIntervalMs` khi `needsRefresh`, và ngừng khi không còn. React Query bỏ qua nhịp khi tab đang ẩn và hỏi
lại khi tab quay lại; một request đang chạy không bao giờ bị nhân đôi, nhịp kế tiếp chờ chính request đó.

## Bản thiết kế của các màn hình

Các màn hình và component của hồ sơ và upload dựa trên bản thiết kế ở [`design/`](../design/README.md). Màn hình nào ứng với mã nào
trong bản thiết kế:

| Component, màn hình | Bản thiết kế |
| --- | --- |
| `components/profile/my-account.tsx`, `my-video-row.tsx`, `features/profile/my-videos-screen.tsx` (My videos) | `design/SVP Mobile.dc.html` M33–M34; `SVP Desktop.dc.html` D09 |
| `components/profile/profile-header.tsx`, `features/profile/profile-screen.tsx` (hồ sơ người khác) | `design/SVP Mobile.dc.html` M35–M37; `SVP Desktop.dc.html` D10 |
| `components/profile/video-grid.tsx` | `design/SVP Mobile.dc.html` M35–M36; `SVP Desktop.dc.html` D10 |
| `components/profile/profile-states.tsx` (trạng thái không có video, 404) | `design/SVP Mobile.dc.html` M37 |
| `components/profile/status-badge.tsx` (huy hiệu trạng thái) | `design/SVP Mobile.dc.html` M33 |
| `components/upload/drop-zone.tsx` (bước 1) | M20, D05, D06 |
| `components/upload/details-form.tsx` (bước 2) | M25, M26 |
| `components/upload/upload-progress.tsx` (bước 3) | M28, M29 |
| `components/upload/upload-result.tsx` (bước 3) | M30–M32 |
| `components/upload/upload-alert.tsx` | M21–M24, M27, M29 |
| `components/upload/upload-frame.tsx` | `design/UploadFlow.dc.html`; D05, D06 |
| `features/upload/upload-screen.tsx` | `design/UploadFlow.dc.html` |

Hai mối đe doạ trong [mô hình mối đe doạ](https://github.com/anhnvcoder/svp-backend/blob/main/docs/threat-model.md) có chỗ ở code của
các màn hình này:

- **WEB-18:** `my-account.tsx` và `profile-header.tsx` bao tên người dùng trong `<bdi>`, vì ký tự điều khiển bidi đảo thứ tự chữ đứng
  sau tên.
- **WEB-1:** tên và tiêu đề của người dùng chỉ được render là text React ở `my-video-row.tsx` và `profile-header.tsx`.

## Số đo trình duyệt (web vitals)

`features/rum/vitals-reporter.tsx` đo web vitals của trang và gửi chúng tới `/rum` (`beacon.ts`).

- **Nạp sau sự kiện load.** `web-vitals` chỉ được nạp sau sự kiện `load` của trang, trong một chunk riêng, nên không lấy gì của lần vẽ
  đầu tiên; các observer của nó đọc những entry mà trình duyệt đã đệm từ trước.
- **Chỉ gắn ở layout gốc.** `VitalsReporter` do layout gốc render. `global-error` thay layout đó, nên gỡ nó khỏi trang, và trang lỗi không
  gửi gì. Dưới `app/error.tsx` và các error boundary lồng, layout gốc vẫn còn mount, nên reporter vẫn chạy và vẫn gửi: các giá trị đó đo
  trang như nó đã tải và chạy trước khi lỗi, là dữ liệu thật, không phải số đọc hỏng của trang lỗi.

Trong `beacon.ts`, beacon gửi khi trang bị ẩn (`visibilitychange`), và listener nằm trên `window`, ở pha bubble: web-vitals báo CLS cuối
cùng (0 với trang chưa từng dịch chuyển) và INP chỉ từ listener pha capture của chính nó cho cùng sự kiện đó, nên chúng đã có trước khi
phần này gửi. Không có listener `pagehide`: rời trang bắn `pagehide` trước, rồi `visibilitychange` sang hidden ngay sau, nên một beacon
gửi ở `pagehide` sẽ bỏ sót CLS và INP. Trang được đưa vào back/forward cache cũng chuyển sang hidden theo cách đó; khi nó quay lại thì
trạng thái được giữ, nên `done` vẫn đang đặt và một lần tải trang vẫn chỉ gửi một beacon.

## Lọc dữ liệu cá nhân trước khi gửi lên GlitchTip

`server/sentry/scrub.ts` đặt hai mẫu mà các service Go cũng che (`internal/sentryx`): địa chỉ email và JWT (mọi JWT bắt đầu bằng
`eyJ`). Cả hai mẫu đọc mỗi đoạn ký tự liền nhau đúng một lần.

- **Email.** Mẫu đọc mỗi đoạn ký tự của phần local một lần. Phần domain là tuỳ chọn, nên một đoạn không có domain vẫn là một match
  (`redactEmail` giữ nguyên nó) và việc tìm tiếp tục sau đoạn. Nếu domain bắt buộc, một domain hỏng làm việc tìm thử lại từ mọi ký tự
  sau đó của đoạn, chi phí tăng theo bình phương độ dài. Khi tuỳ chọn, mẫu vẫn khớp đúng các địa chỉ như khi bắt buộc: domain phải theo
  sau cả đoạn, vì chỉ ký tự cuối của một đoạn mới đứng ngay trước `@`.
- **JWT.** Mẫu cũng đọc mỗi đoạn ký tự base64url như một khối: hai phần cách nhau bởi dấu chấm theo sau chỉ được lấy khi đoạn có một
  `eyJ` với ít nhất một ký tự sau nó, và token bắt đầu ở `eyJ` đầu tiên của đoạn. Ngược lại, match chính là cả đoạn, `redactJwt` giữ
  nguyên nó, và việc tìm tiếp tục sau đó, nên một token bắt đầu ở đoạn sau vẫn được tìm thấy. Nếu khớp từ chính `eyJ`, mỗi `eyJ` của
  một đoạn không phải token làm việc tìm đọc lại phần còn lại của đoạn, chi phí tăng theo bình phương độ dài. Một `eyJ` sau của cùng đoạn
  gặp đúng hai dấu chấm như `eyJ` đầu, nên cả hai dạng che cùng các token.

## Trace và số đo của server web (OpenTelemetry)

`server/telemetry/otel.ts` đặt W3C TraceContext trên các lời gọi server thực hiện, và không bao giờ đọc nó từ request server nhận. Không
thành phần nào phía trước container `web` của compose bỏ `traceparent` của trình duyệt, nên nếu đọc nó thì client nào cũng chọn được
trace id của span của web và, qua các lời gọi của BFF, của span của gateway. Vì vậy mỗi request tới web mở một trace mới, span riêng của
Next cũng vậy (Next đọc ngữ cảnh đến qua propagator toàn cục này), và các lời gọi của BFF mang trace đó tới gateway. Không có baggage.

`startSdk` khởi động SDK với cấu hình này, và vá module `http` đã được nạp. Instrumentation `http` vá `http` khi nó được `require` sau
lúc SDK chạy, nhưng việc đó không bao giờ xảy ra ở server: `start-server.js` của Next `require` `http` trước khi `register()` chạy, và
bundle chỉ `require` mỗi module built-in một lần rồi giữ nó, nên không `require` nào sau khi SDK chạy chạm tới hook của instrumentation.
Không có bản vá, web không có server span riêng và không có `http.server.request.duration`, histogram của SLO khả dụng của nó. Nạp
`http` thêm một lần qua hook mà instrumentation đã cài sẽ vá module tại chỗ, kể cả `http.Server.prototype.emit` mà server Next đã tạo
tra cứu ở mỗi request. Dùng `process.getBuiltinModule` chứ không `require`: bundler biến `require` thành bản cache của module mà nó giữ,
và bản đó không bao giờ chạm tới hook.

## Server: OpenTelemetry và standalone output

Trong `next.config.ts`, SDK OpenTelemetry của `server/telemetry/otel.ts` được Node nạp từ `node_modules`, không được bundle. Các bản ES
module của nó nạp một số dependency bằng `require` tạo từ `createRequire(import.meta.url)` ở một module khác, mà bundler không theo
được: khi bundle, `@grpc/grpc-js` (các exporter OTLP/gRPC) vắng khỏi standalone output và mọi lần export lỗi với "Cannot find module",
trong khi server vẫn chạy. Để external thì mỗi gói được trace cùng dependency của nó, kể cả `@grpc/grpc-js` (các exporter cũng import
nó trực tiếp). Danh sách `serverExternalPackages` gồm mọi gói mà server import, để chỉ có một bản SDK chạy.

## i18n: thông điệp biên dịch lúc build

Locale và thông điệp của mỗi request được đọc từ `i18n/request.ts` (URL không có tiền tố locale). Mọi file thông điệp dưới `messages/` được
biên dịch lúc build, nên cả server lẫn trình duyệt không parse cú pháp ICU lúc chạy: bundle của trình duyệt mang một formatter nhỏ thay
cho bộ parse ICU (nhẹ hơn khoảng 8 kB gzip trên mọi trang, toàn bộ được tải trước lần vẽ đầu tiên của trang). Unit test import các file
JSON như hiện có và format theo cách thông thường.

## Source map và GlitchTip

`next.config.ts` bật source map của bundle trình duyệt để GlitchTip hiện được stack của một lỗi trình duyệt theo source. Chúng không
bao giờ tới trình duyệt: lúc build image, source map bị chuyển ra khỏi `.next/static` và các comment `sourceMappingURL` bị bỏ, rồi
chúng chỉ được gửi tới GlitchTip (`make sourcemaps`). `next build` của `make check` cũng ghi chúng, để ngân sách bundle đo đúng các
chunk mà image phục vụ.

## Test e2e

Test end-to-end chạy trên stack compose (`make e2e`) hay cluster k3d (`make k8s-e2e`) của backend; lệnh ở [`README.md`](../README.md).

### Stack mà một lượt e2e nói chuyện với

`e2e/stack.ts` chọn stack từ `SVP_STACK`: `compose` (mặc định, `make e2e`) hoặc `k3d` (`make k8s-e2e`). Mọi origin, và dạng của session
cookie, đều lấy từ đây, nên không spec nào ghi địa chỉ của một stack.

- **compose:** container `web` ở `http://localhost:3001`, gateway và object store (service `s3`) ở các cổng loopback của chúng. http
  thường, nên session cookie không có tiền tố và không có `Secure`.
- **k3d:** cluster `svp` sau Envoy ở `127.0.0.1:8443`, mỗi route một tên: web ở `https://svp.localhost:8443`, gateway ở
  `api.svp.localhost`, storage (upload và media) ở `s3.svp.localhost`; mọi tên `*.localhost` trỏ về loopback ở Chromium và WebKit như
  nhau. https, nên cookie là `__Host-Http-svp_sid` với `Secure`. Chứng chỉ của cluster do CA riêng của nó cấp (`.k8s/ca.crt`).

### Rate limit và dữ liệu dùng chung

`e2e/fixtures.ts` chứa các helper dùng chung của test. BFF tới gateway từ một địa chỉ duy nhất của container `web`, nên mọi trình duyệt
dùng chung các bucket theo IP của gateway: đăng ký (burst 20 mỗi giờ), login-ip (burst 30, 60 mỗi phút). Vì vậy:

- user của test được đăng ký thẳng ở gateway; mỗi project đăng nhập qua web khoảng 8 lần và đăng ký qua web một lần (luồng chính);
  `e2e/seed.sh` đặt lại bucket đăng ký trước mỗi lượt chạy;
- mỗi user đăng nhập tối đa 3 lần, dưới burst 5 của login-email;
- đăng ký ở gateway dùng bucket của chính máy này, cũng burst 20, nạp lại một lượt mỗi phút: một lượt chạy trọn vẹn đăng ký nhiều user
  hơn thế trong vài phút (28 ở một lượt chạy chứng cứ), nên mỗi worker đặt lại các bucket đăng ký một lần nữa trước test đầu tiên của nó
  (fixture `registerLimitReset`, **LOCAL LAB ONLY**);
- một worker chạy một project, đăng ký tối đa 9 lần (Chromium hay WebKit trong một lượt chạy chứng cứ, kể cả `sessionAccount` của nó);
  test mới vẫn dùng lại `sessionAccount` của worker khi có thể;
- trên k3d, mọi lần đăng ký của một worker, qua BFF hay thẳng tới gateway, rơi vào cùng một bucket: BFF chuyển tiếp `X-Forwarded-For`
  đúng như nhận được và gateway đọc địa chỉ do Envoy ghi (`server/gateway.ts`), như nhau cho cả hai. Ngân sách ở đó chặt hơn trên
  compose; việc đặt lại trước test đầu tiên của mỗi worker giữ nó dưới burst.

**LOCAL LAB ONLY:** trước test đầu tiên của mỗi worker (mỗi project một worker, và một worker mới sau một test lỗi), các khoá rate limit
đăng ký của gateway (`svp:gw:rl:register:*`) ở Redis db 10 trên `127.0.0.1:6379` (trên k3d: Valkey db 10 của cluster `svp`, qua
`kubectl`, như `SVP_STACK=k3d` báo cho `lib.sh`) bị xoá bằng `SCAN` + `DEL`, bởi `reset_register_limit` của `deploy/compose/lib.sh`, như
`e2e/seed.sh` và `make smoke` làm; bản thân giới hạn không được nâng lên. Không bao giờ trỏ lượt e2e vào stack dùng chung.

### Lỗi trình duyệt tới GlitchTip với stack đã ánh xạ

`e2e/glitchtip.e2e.ts` kiểm một lỗi trình duyệt của bundle thật tới được GlitchTip với stack đã ánh xạ về source. Nó chỉ chạy khi có
`SVP_E2E_GLITCHTIP=1` (`playwright.config.ts`), trên stack mà GlitchTip giữ source map của đúng bản build web đang phục vụ: compose
`make up OBS=lgtm` rồi `make sourcemaps`, hoặc k3d `make k8s-sourcemaps` rồi `make k8s-e2e`.

- **Lỗi không đến từ đường debug nào của app.** Trang kế của Explore được trả bằng một item có `title` là object thay vì text, và React,
  khi render title đó, ném lỗi tới error boundary của `app/error.tsx`, nơi báo nó qua `POST /monitoring`. Mọi lời gọi client của app tự
  kiểm các field nó dùng và bắt lỗi, nên một câu trả lời sai dạng không làm code của chính app ném lỗi; các frame là của React, ánh xạ về
  source của nó dưới `node_modules` của dự án web.
- **API của GlitchTip đọc bằng token chỉ đọc** (`event:read`, `project:read`), không bao giờ in ra: compose lấy `SENTRY_AUTH_TOKEN` trong
  `.env` của backend (đọc bằng `deploy/observability/glitchtip/dotenv.sh` của nó); k3d lấy token của Secret `svp-obs/glitchtip-api` từ
  `e2e/k3d-e2e.sh` vào `SVP_E2E_GLITCHTIP_TOKEN`. GlitchTip ở `127.0.0.1:8000` trên cả hai: compose publish nó ở đó, `e2e/k3d-e2e.sh`
  mở một port-forward ở đó cho lượt chạy. Event của mỗi trình duyệt, khi tìm thấy, được ghi vào `test-results/glitchtip-<project>.json`
  (cùng environment mà GlitchTip giữ cho nó), là bản ghi của lượt chạy về những gì GlitchTip nhận.
