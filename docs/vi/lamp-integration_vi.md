# Tích hợp Lamp với Harness CLI — protocol v1

Code đã được viết; **chưa hoàn tất kiểm thử xuyên suốt hoặc trên thiết bị thật**. Contract wire đầy đủ
ở [bản tiếng Anh](../lamp-integration.md). Đây là mô tả implementation, không phải chứng nhận
interoperability từ các test chưa chạy.

## Kiến trúc và pairing

Lamp kết nối trực tiếp WebSocket LAN tới CLI; Desktop quản lý pairing qua hook API loopback có
credential. Đóng Desktop không ngắt lamp. Không cần backend cloud hoặc SSO token trên lamp.
Chỉ tương tác agent trên máy đã pair; không shell/raw terminal, tạo/xóa agent, máy từ xa, đổi model
hay duyệt quyền tool. OS giữ target hội thoại và luôn gửi machineId/agentId cụ thể.

Listener mặc định `0.0.0.0:18474`, URL `/api/lamp-ws`; chỉnh bằng `HARNESS_LAMP_BIND` và
`HARNESS_LAMP_PORT`. Chưa có mDNS/HARNESS_LAMP_IFACE. Người dùng nhập địa chỉ cùng mã.
Máy mới chưa pair không mở listener. Listener tồn tại khi có trust, ứng viên pairing hoặc cửa sổ
pairing; khi không còn thì đóng trong khoảng một giây. Máy có nhiều interface nên bind địa chỉ cụ
thể nếu địa chỉ IPv4 đầu tiên không phù hợp.

Người dùng mở cửa sổ pairing tại máy tính: mã sáu ký tự, hạn 60 giây, tối đa ba lần thử PAKE.
CLI là CPace initiator; lamp responder. CPace tái sử dụng crypto core hiện có (Ristretto255 XMD
SHA-512; không tương thích wire draft IETF). Không có bước so fingerprint; fingerprint chỉ hiển thị.

Mỗi CLI có một lamp chính thức và tối đa một ứng viên tạm. Khi đã pair, mở cửa sổ mới trả
`ALREADY_PAIRED`; cần chủ động `replace:true`. Lamp cũ tiếp tục hoạt động trong quá trình này.
Round 4 chỉ lưu ứng viên, round 5 xác nhận nhận identity; **chỉ khi nhận encrypted lamp_finished
với challenge của welcome** mới thay thế lamp cũ. Ứng viên hết hạn sau năm phút, kể cả qua restart.
Mất round 5 có thể phục hồi bằng provisional pin và session có chữ ký. Cancel/lỗi/hết hạn không
xóa lamp cũ. Trust đã xác nhận không mất khi offline.

`lampId`/`id` là public key Ed25519 32 byte dạng canonical base64, không phải fingerprint. File
`${ADAPTER_DATA_DIR}/e2e/lamps.json` có `{v:1,paired,pending}`, ghi thay thế atomic mode 0600,
folder 0700. Tái sử dụng secureState để từ chối symlink, owner/type sai và state cũ cho nhóm/người
khác quyền ghi; file giới hạn 16 KiB. File tạm exclusive/no-follow được fsync trước rename và
folder được fsync sau đó. Store hỏng khiến xử lý thất bại an toàn, không tự xóa trust. Revoke đóng session ngay,
hủy delivery đang chờ và xóa receipt cũ; không thể thu hồi prompt đã inject.

## Quản lý từ CLI/Desktop

Daemon phải đang chạy. Các lệnh:

```sh
harness lamp status --json
harness lamp pair
harness lamp pair-status
harness lamp cancel
harness lamp list --json
harness lamp pair --replace
harness lamp revoke '<base64-id>'
harness lamp revoke --all
```

Desktop dùng hook server loopback với `Authorization: Bearer <hook credential>`; không mở listener
LAN trong Flutter. Kết quả là JSON trực tiếp; lỗi `{error:{code,message}}` kèm HTTP status.

| Endpoint | Mục đích |
|---|---|
| POST `/api/lamp/pair/start` | `{}` hoặc `{replace:true}` → mã, hạn, machineId/name, address, fingerprint |
| POST `/api/lamp/pair/cancel` | Hủy ứng viên/cửa sổ; giữ lamp chính thức |
| GET `/api/lamp/pair/status` | idle/waiting/running/paired/failed; không trả mã |
| GET `/api/lamp/list` | `{lamps:[...]}` với id, label, fingerprint, online, pendingFirstSession |
| GET `/api/lamp/status` | listening/bind/port/address/paired/sessions/serverInstanceId/proto |
| POST `/api/lamp/revoke` | `{id}` hoặc `{all:true}` → `{revoked:n}` |
| GET `/api/lamp/receipt?lampId=…&idempotencyKey=…` | Receipt hoặc null; URL-encode query |

`paired` đếm lamp chính thức; list có thể có thêm ứng viên `pendingFirstSession:true`.
`online:false` không đồng nghĩa đã unpair. Mã chỉ có trong response của pair/start.

## Session, thao tác và độ tin cậy

Không TLS; nội dung được mã hóa end-to-end ở tầng ứng dụng. Chỉ handshake/metadata được gửi rõ.
Chữ ký Ed25519 của hello/welcome bảo vệ canonical JSON toàn frame, bỏ **sig cấp cao nhất**, giữ
sig lồng bên trong. Welcome chứa challenge UUID mới. Lamp kiểm chữ ký pinned CLI rồi gửi encrypted
`lamp_finished`; CLI trả encrypted `lamp_ready` và replay/resync. Hello bị replay mà không có
private ephemeral không thể ngắt lamp đang hoạt động.

Frame ngoài `{type,agentId?,payload:{__e2e:{v:1,k:"p",n,ct}}}`; plaintext chứa toàn request/result/event.
Type/agentId trong và ngoài phải khớp. ChaCha20-Poly1305 AAD `1|<type>|<agentId hoặc rỗng>|p|`;
nonce là counter 8 byte big-endian + bốn byte zero. Counter mỗi chiều từ 0, finished/ready dùng 0.
Replay window 4096. Không gửi prompt/recap/answer plaintext.

Các capability: `agents.list`, `status`, `recap`, `turn.send`, `turn.stop`, `question.answer`,
`receipt.get`. Mọi request có UUIDv4 requestId; mutation thêm idempotencyKey `[A-Za-z0-9_-]{1,64}`.
Targeted request bắt buộc machineId/agentId. Prompt không rỗng, tối đa 16 KiB UTF-8, không cắt ngắn.
Recap n mặc định 3, phạm vi 1–5; kết quả `turns:[{kind,text,recap?}]`.
Status trả state running/idle và openQuestion `{requestId,questions}` hoặc null.
Answer dùng `questionRequestId,answers` (object string), không được duyệt tool permission.

Receipt có state queued/delivered/started/completed/rejected/unknown; UUID deliveryId và
serverInstanceId, turnId tương quan cục bộ khi start được quan sát. Stop/answer thành công có
receipt completed; chưa xác nhận là unknown. Status chỉ có accepted/duplicate, không có status rejected. Sau reserve luôn trả receipt, kể cả
khi bị revoke hoặc lỗi; lỗi nằm trong receipt.error và receipt.state có thể rejected/unknown.
Accepted không đồng nghĩa giao được prompt hay hoàn tất. Chỉ lỗi chắc
chắn chưa giao prompt mới được rejected. Receipt null là không có thông tin, không phải chưa chạy.

Dedupe reserve trước dispatch, so toàn intent ngoài correlation IDs. Same key khác payload trả
IDEMPOTENCY_CONFLICT. Tối đa 512 receipt trong RAM: completed/rejected hết hạn sau 30 phút kể
từ transition cuối. Khi đủ 512, loại receipt completed/rejected cũ nhất dù chưa đủ TTL. Không
loại outstanding/unknown để tránh chạy lặp prompt còn sống; nếu toàn bộ 512 chưa rõ kết quả thì
trả BACKPRESSURE. Đây là ngoại lệ an toàn với quy tắc loại entry cũ nhất vô điều kiện. Key bị loại
có thể được coi là mới; receipt null không được dẫn tới tự gửi lại. Restart đổi serverInstanceId và mất receipt; **không tự replay mutation**.

Event có `{type:"event",eventId,serverInstanceId,machineId,agentId?,kind,payload}`, ring 500 phần tử.
Các kind: receipt.updated, turn.started/done/error/summary/tool, agent.error, question.open/close.
Cursor là cặp instance/eventId. Instance khác hoặc cursor quá cũ → resync; OS đọc lại agents/status
và tra receipt. Queued thì chờ; delivered/started/completed thì nhận kết quả; rejected thì báo lỗi;
unknown/null phải kiểm tra và hỏi trước khi gửi lại.

Giới hạn: frame 64 KiB, 16 socket, auth deadline 10 giây, ping 20 giây. Mỗi identity có token bucket
burst 20, refill một request/giây và tối đa bốn request async đồng thời; reconnect không reset quota.
Buffer gửi >1 MiB đóng 1011 để reconnect/resync; chưa có cam kết timeout request phía server.
Close 4408 là session cũ bị cùng lamp thay thế (không reconnect), 4410 là lamp khác thay thế;
4403 revoked, 4404 unknown, 4409 sai protocol. Denial rõ chưa được xác thực không được dùng để
âm thầm xóa durable trust trước khả năng giả mạo trên mạng.

## Fixture và kiểm thử

Fixture deterministic dùng **khóa test công khai** tại
`cli/src/lib/lamp/vectors/lamp-protocol.json`. Bao gồm generator/scalar CPace, shared secret,
ISK/MAC, identity ciphertext, signed hello/welcome, session keys, encrypted lamp_finished (client counter 0), lamp_ready (server counter 0) và
Unicode prompt (client counter 1). Challenge có chữ ký cùng bước finished là bắt buộc trong v1.
Generator: từ `cli/` chạy `./node_modules/.bin/tsx src/lib/lamp/vectors/generate.ts`.
Đã sinh fixture; việc sinh không phải chạy test. Các test đã viết nhưng chưa chạy theo yêu cầu ưu tiên
hoàn tất code ba repo. Trước release cần typecheck/test/build CLI, fixture test chéo Go/TypeScript
và thử pairing/voice trên thiết bị khi được cho phép. Chưa deploy hoặc pair thiết bị thật.
