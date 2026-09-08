# Tích hợp Autonomous device với Harness CLI — protocol v1

Code đã triển khai và kiểm thử loopback từ Go OS client thật tới CLI thành công; **chưa thử
trên thiết bị vật lý**. Contract wire đầy đủ
ở [bản tiếng Anh](../autonomous-device-integration.md). Đây là mô tả implementation, không phải chứng nhận
interoperability từ các test chưa chạy.

## Kiến trúc và pairing

Autonomous device kết nối trực tiếp WebSocket LAN tới CLI; Desktop quản lý pairing qua hook API loopback có
credential. Đóng Desktop không ngắt device. Không cần backend cloud hoặc SSO token trên device.
Chỉ tương tác agent trên máy đã pair; không shell/raw terminal, tạo/xóa agent, máy từ xa, đổi model
hay duyệt quyền tool. OS giữ target hội thoại và luôn gửi machineId/agentId cụ thể.

Listener mặc định `0.0.0.0:18474`, URL `/api/autonomous-device-ws`; chỉnh bằng `HARNESS_AUTONOMOUS_DEVICE_BIND` và
`HARNESS_AUTONOMOUS_DEVICE_PORT`. Chưa có mDNS/HARNESS_AUTONOMOUS_DEVICE_IFACE. Người dùng nhập địa chỉ cùng mã.
Máy mới chưa pair không mở listener. Listener tồn tại khi có trust, ứng viên pairing hoặc cửa sổ
pairing; khi không còn thì đóng trong khoảng một giây. Máy có nhiều interface nên bind địa chỉ cụ
thể nếu địa chỉ IPv4 đầu tiên không phù hợp.

Máy tính mở listener tuyển kết nối 60 giây qua pair/listen, không sinh mã. Autonomous device
tự sinh và hiển thị mã sáu ký tự rồi kết nối tới địa chỉ máy tính. Desktop/CLI nhận mã do người
dùng nhập từ thiết bị; chỉ khi pair/start nhận đúng pending pairId mới bắt đầu PAKE. Tối đa ba
lần thử trong cửa sổ. Không response nào trả/echo mã.
CLI là CPace initiator; device responder. CPace tái sử dụng crypto core hiện có (Ristretto255 XMD
SHA-512; không tương thích wire draft IETF). Không có bước so fingerprint; fingerprint chỉ hiển thị.

Mỗi CLI có một device chính thức và tối đa một ứng viên tạm. Khi đã pair, mở cửa sổ mới trả
`ALREADY_PAIRED`; cần chủ động `replace:true`. Autonomous device cũ tiếp tục hoạt động trong quá trình này.
Round 4 chỉ lưu ứng viên, round 5 xác nhận nhận identity; **chỉ khi nhận encrypted autonomous_device_finished
với challenge của welcome** mới thay thế device cũ. Ứng viên hết hạn sau năm phút, kể cả qua restart.
Mất round 5 có thể phục hồi bằng provisional pin và session có chữ ký. Cancel/lỗi/hết hạn không
xóa device cũ. Trust đã xác nhận không mất khi offline.

`deviceId`/`id` là public key Ed25519 32 byte dạng canonical base64, không phải fingerprint. File
`${ADAPTER_DATA_DIR}/e2e/autonomous-devices.json` có `{v:1,paired,pending}`, ghi thay thế atomic mode 0600,
folder 0700. Tái sử dụng secureState để từ chối symlink, owner/type sai và state cũ cho nhóm/người
khác quyền ghi; file giới hạn 16 KiB. File tạm exclusive/no-follow được fsync trước rename và
folder được fsync sau đó. Store hỏng khiến xử lý thất bại an toàn, không tự xóa trust. Revoke đóng session ngay,
hủy delivery đang chờ và xóa receipt cũ; không thể thu hồi prompt đã inject.

## Quản lý từ CLI/Desktop

Daemon phải đang chạy. Các lệnh:

```sh
harness autonomous-device status --json
harness autonomous-device listen
harness autonomous-device pair <device-code>
harness autonomous-device pair-status
harness autonomous-device cancel
harness autonomous-device list --json
harness autonomous-device listen --replace
harness autonomous-device pair <device-code> --replace
harness autonomous-device revoke '<base64-id>'
harness autonomous-device revoke --all
```

Desktop dùng hook server loopback với `Authorization: Bearer <hook credential>`; không mở listener
LAN trong Flutter. Kết quả là JSON trực tiếp; lỗi `{error:{code,message}}` kèm HTTP status.

| Endpoint | Mục đích |
|---|---|
| POST `/api/autonomous-device/pair/listen` | `{replace?}` → state listening, hạn, machineId/name, address, fingerprint; không mã |
| POST `/api/autonomous-device/pair/start` | `{code,pairId?,replace?}` → state running và metadata pending intent; không echo mã |
| POST `/api/autonomous-device/pair/cancel` | Hủy ứng viên/cửa sổ; giữ device chính thức |
| GET `/api/autonomous-device/pair/status` | idle/listening/waiting/running/paired/failed; không trả mã |
| GET `/api/autonomous-device/list` | `{devices:[...]}` với id, label, fingerprint, online, pendingFirstSession |
| GET `/api/autonomous-device/status` | listening/bind/port/address/paired/sessions/serverInstanceId/proto |
| POST `/api/autonomous-device/revoke` | `{id}` hoặc `{all:true}` → `{revoked:n}` |
| GET `/api/autonomous-device/receipt?deviceId=…&idempotencyKey=…` | Receipt hoặc null; URL-encode query |

`paired` đếm device chính thức; list có thể có thêm ứng viên `pendingFirstSession:true`.
`online:false` không đồng nghĩa đã unpair. Thiết bị sinh và hiển thị mã. Desktop dùng `pair --code-stdin --pair-id <id>` và đóng stdin sau
khi ghi mã; không đưa mã vào argv/log. Cả listen/start yêu cầu replace:true nếu đã có incumbent.
Sai pairId trả STALE_PAIR; chưa có intent trả NO_INTENT; đang PAKE trả BUSY.

## Session, thao tác và độ tin cậy

Không TLS; nội dung được mã hóa end-to-end ở tầng ứng dụng. Chỉ handshake/metadata được gửi rõ.
Chữ ký Ed25519 của hello/welcome bảo vệ canonical JSON toàn frame, bỏ **sig cấp cao nhất**, giữ
sig lồng bên trong. Welcome chứa challenge UUID mới. Autonomous device kiểm chữ ký pinned CLI rồi gửi encrypted
`autonomous_device_finished`; CLI trả encrypted `autonomous_device_ready` và replay/resync. Hello bị replay mà không có
private ephemeral không thể ngắt device đang hoạt động.

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
Close 4408 là session cũ bị cùng device thay thế (không reconnect), 4410 là device khác thay thế;
4403 revoked, 4404 unknown, 4409 sai protocol. Denial rõ chưa được xác thực không được dùng để
âm thầm xóa durable trust trước khả năng giả mạo trên mạng.

## Fixture và kiểm thử

Fixture deterministic dùng **khóa test công khai** tại
`cli/src/lib/autonomous-device/vectors/autonomous-device-protocol.json`. Bao gồm generator/scalar CPace, shared secret,
ISK/MAC, identity ciphertext, signed hello/welcome, session keys, encrypted autonomous_device_finished (client counter 0), autonomous_device_ready (server counter 0) và
Unicode prompt (client counter 1). Challenge có chữ ký cùng bước finished là bắt buộc trong v1.
Generator: từ `cli/` chạy `./node_modules/.bin/tsx src/lib/autonomous-device/vectors/generate.ts`.
Đã sinh fixture; việc sinh không phải chạy test. Sau sửa chiều pairing, `npm run typecheck` đạt; full `npm test` đạt 144 file/1873 test,
bỏ qua 5 file/50 test (30,41 giây). Trước release cần
build CLI, fixture test chéo Go/TypeScript và thử pairing/voice trên thiết bị khi được cho phép.
Chưa deploy hoặc pair thiết bị thật.

Luồng thiết bị sinh mã đã đạt typecheck và 53 test CLI; kiểm thử Go OS client → CLI thật qua
loopback đạt: sai mã bị từ chối, session mã hóa, list/send/dedupe, giữ incumbent khi thay thế lỗi
và đổi thiết bị thành công. Không coi loopback là thử nghiệm trên thiết bị vật lý.
