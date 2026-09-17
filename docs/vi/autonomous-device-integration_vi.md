# Autonomous device ↔ Mac trực tiếp

Mac tự tìm Autonomous OS qua service Avahi `_autonomous._tcp` đang có, dùng bonjour-service
browse ba giây. Không nhập IP, không backend relay hoặc credential cloud trên thiết bị. Giữ
login/start của Harness Mac như cũ; daemon đang chạy vẫn pair/điều khiển khi backend offline.
Buddy không dùng và không sửa.

```sh
harness autonomous-device discover --json
harness autonomous-device pair --device '<discovery-id>' --code-stdin
harness autonomous-device status --json
harness autonomous-device list --json
harness autonomous-device revoke '<full fingerprint>'
```

Thiết bị sinh/hiển thị mã; Desktop chọn thiết bị tìm thấy rồi ghi mã vào stdin của CLI, không argv/log.
Discovery trả `{devices:[{id,name,host,port}]}`. CLI dial trực tiếp
`ws://<host>:<SRV-port>/api/harness/ws`, dùng đúng port quảng bá (có thể80), nginx chuyển Upgrade
cho route đó. Không hardcode5000, không thêm Avahi/script. Frame đầu machine_select payload
machineId/label; OS trả machine_selected và e2e_pair_intent nếu đang pair. Sau mã nhập đúng, chạy
PAKE và e2e_hello/welcome gốc; CLI chờ session đúng identity trước báo paired.

Không listener Mac mới, custom handshake/trust store, role mới hay backend onboarding. Inbound
trực tiếp chỉ nhận PAKE/cancel/hello/status cần thiết và app RPC; không setup token/remote password,
terminal/admin. Intent/PAKE chỉ được nhận trong lần pair chủ động. Backend offline không xóa
direct session hoặc cho phép pair nhầm browser slot.

Metadata `${ADAPTER_DATA_DIR}/autonomous-device-connections.json` chỉ lưu discoveryId/fingerprint;
key/pin vẫn ở E2eeManager/paired.json gốc. Mỗi15giây tìm lại thiết bị đã lưu và reconnect. Publickey
reconnect phải đúng fingerprint association; mDNS không cấp quyền. Revoke đóng socket và bỏ
association, không ảnh hưởng browser/dial khác. Sai mã đóng attempt để lần sau có socket/intent mới.
Chỉ app hello đã xác thực mới bật recap/notification.

Facade loopback có credential: GET discover; POST pair/start `{code,device}`; GET pair/status;
GET status (transport direct); GET list (id là fingerprint, khác discoveryId); POST revoke `{id}`;
GET receipt query deviceId canonical publickey và idempotencyKey. Không listen/address/replace/all.

Khi device tự revoke trust cục bộ, nó gửi application request đã xác thực
`{type:"pair.revoke",requestId}` và đợi `pair.revoke_result` trước khi đóng socket. CLI sẽ xóa đúng
identity đó cùng metadata reconnect. Socket chỉ đóng mà không có request này vẫn là `offline`, không
được hiểu là revoke, để lỗi mạng thoáng qua không unpair device.

Revoke là hai chiều. Khi app gỡ device (`harness unpair`, `harness unpair --all`,
`harness autonomous-device revoke`, hoặc dashboard) trong lúc session direct của device đang mở, CLI
seal `{type:"pair.revoke",machineId:<machineId của máy này>}` dưới dạng `autonomous_device_event` trên
chính session E2EE đó, rồi đóng socket nhẹ nhàng và xóa trust local. Best-effort: gửi lỗi không chặn
việc gỡ local. Device đang offline lúc đó sẽ biết khi reconnect: `e2e_hello` với pin cũ bị trả
`e2e_denied` (`unpaired`).

Wire dùng nguyên e2e_* gốc role device, CI b:device. App outer autonomous_device_request/result/event
vẫn pairwise encrypted với empty dbSessionId AAD; helper relay.ts chỉ là adapter ứng dụng dùng chung
crypto, không kết nối backend. Request agents.list/status/recap/turn.send/turn.stop/question.answer/
receipt.get giữ target rõ và receipt/dedupe. Không replay mutation khi mất kết nối; unknown không
có nghĩa chưa gửi. Cache512/ring500 và schema đầy đủ ở [bản EN](../autonomous-device-integration.md).

## Focus của app cho voice

CLI quảng bá capability `focus.get`; request `{type:"focus.get",requestId}` trả
`{type:"focus.get_result",requestId,focus:null|{machineId,agentId,name?},focusRevision}`.
Event `focus.changed` có payload `{focus,focusRevision}` cùng schema. Monitor Pairing hiển thị
snapshot này; OS có thể poll để phục hồi khi bỏ lỡ event.

Nguồn focus là frame local tường minh `app_focus {agentId}` từ Desktop, không phải `terminal_open`.
Ban đầu focus là null. `app_focus {agentId:null}` hoặc đóng socket đang sở hữu focus sẽ xóa focus;
socket cũ không được xóa focus của socket mới. Mỗi thay đổi focus đổi revision, kể cả A→B→A; thông báo lại cùng target giữ nguyên revision
nhưng chuyển quyền sở hữu sang socket thông báo;
revision là chuỗi opaque có server instance ID nên khác sau restart. Khi đọc snapshot, agent local
đã bị xóa làm focus thành null và đổi revision. Focus máy remote giữ đúng machine ID remote;
facade device chỉ hỗ trợ máy đã pair, không thay bằng agent local hoặc tự relay task.

`turn.send` và `question.answer` nhận `focusRevision` tùy chọn bên cạnh target ID tường minh.
Sau bước kiểm tra receipt trùng, service kiểm tra đồng bộ revision và target trước khi reserve/gửi.
Sai revision hoặc target trả `FOCUS_CHANGED` không receipt: request đó chưa dispatch. Request trùng
đã reserve vẫn trả receipt cũ dù focus đổi. Client cũ không truyền revision vẫn dùng target tường minh
như trước. `turn.stop` không nhận trường này, tiếp tục nhắm target của lượt đang chạy.

`turn.summary` và mỗi phần tử `recap.turns[]` mang ba mức của cùng một câu trả lời; bên tiêu thụ nên
ưu tiên `turns[].fullText`, rồi `turn.summary.fullText`, rồi `text`:

| Trường | Giới hạn | Là gì |
|---|---|---|
| `recap` | 60 ký tự | câu văn xuôi đầu tiên — tiêu đề ô tile |
| `text` | 250 ký tự | câu trả lời bị làm phẳng một dòng rồi cắt — để liếc |
| `fullText` | 8192 byte UTF-8 | tin nhắn cuối của agent đúng như hiện trên màn hình, giữ markdown và xuống dòng |

`fullText` là tuỳ chọn, vắng mặt khi chưa ghi được câu trả lời nào, nên phải đọc phòng thủ. Nó chỉ chứa
phản hồi cuối hướng tới người dùng — không có transcript tool, suy luận ẩn hay output terminal — và
không tốn thêm lần gọi model: đó chính là văn bản mà bộ tóm tắt cục bộ vốn đã nhận.

Trần 8192 byte là phép tính chứ không phải khẩu vị: socket direct nhận 65536 byte, `recap` có thể trả
năm lượt một lần, và payload đã seal phình khoảng 37% qua AEAD và base64. Cắt vượt trần là cắt an toàn
UTF-8, kèm `…` ở cuối. `text` và `recap` giữ nguyên từng byte, và card `commander_event` dùng chung
không bị nới — encoder của dial USB ném lỗi khi frame vượt 8 KiB, nên trường này chỉ thêm vào event do
service này phát ra.

Typecheck/focused test đã đạt gồm chỉ chọn discovery, retry socket mới, chờ authenticated identity
và từ chối reconnect giả mạo. Real mDNS/direct Go OS ↔ CLI đã đạt khi backend chưa từng kết nối: discovery SRV, sai mã/retry,
PAKE/session, encrypted list/send/dedupe, restart/reconnect và revoke/unpair. Status chỉ đếm direct
session đã xác thực và app-ready, không đếm socket thô. Full CLI đã đạt với
`npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000`: 144 file / 1.871 test pass,
5 file / 50 test skip; `npm run typecheck` đạt. Lần chạy deadline mặc định 5 giây bị timeout ở
các test password/scrypt sẵn có khi máy chịu tải. Chỉ đổi deadline qua lệnh chạy serial, không
sửa test hoặc cấu hình để né lỗi. Không deploy hoặc pair thiết bị thật.

### Agent mặc định khi bật mode

Capability tùy chọn `focus.ensure` nhận `{type:"focus.ensure",requestId}` và trả cùng snapshot
`{focus,focusRevision}` như `focus.get`. Nếu app đã có focus thì giữ nguyên, kể cả máy remote;
OS vẫn từ chối target remote chưa được hỗ trợ. Nếu chưa có focus, CLI yêu cầu một cửa sổ Desktop
local chọn agent đầu tiên theo thứ tự `agents.list`, dùng flow chọn pane hiện có. Desktop đang có
lựa chọn sẽ gửi lại focus đó thay vì thay đổi. Chỉ xác nhận `app_focus` mới thiết lập target chính thức;
không gửi task hay tự đặt target khi không có app.
Các request đồng thời dùng chung lần chờ tối đa hai giây. Không có agent trả `NO_AGENTS`; không có
cửa sổ hoặc không nhận xác nhận trả `FOCUS_UNAVAILABLE`. Frame local `device_focus` có thời hạn để
request đến trễ không mở pane sau khi hết thời gian chờ. Chỉ gọi khi bật voice mode, không gọi giữa
utterance để tự đổi target. CLI cũ chưa có capability cần chọn agent trong app. Pairing, đọc focus,
event và dispatch task thông thường giữ nguyên.
Xác nhận focus tự động mang revision ban đầu; CLI bỏ qua nếu user đã chọn focus mới trong lúc request đang truyền.

### Chuyển focus từng bước

`focus.step` là một nấc xoay của carousel trên dial USB, nhưng do thiết bị đã pair yêu cầu thay vì ngón tay:

```json
{"type":"focus.step","requestId":"<uuid>","idempotencyKey":"<uuid mỗi gesture>","direction":"next","focusRevision":"<từ focus.get>"}
```

`direction` là `next` hoặc `previous`; `idempotencyKey` khớp `[A-Za-z0-9_-]{1,64}`; `focusRevision`
bắt buộc. Thành công trả đúng snapshot `{focus,focusRevision}` như `focus.get`, đọc **sau khi** Desktop
xác nhận lựa chọn mới qua frame `app_focus` thông thường; event `focus.changed` mang cùng snapshot như
mọi lần đổi focus khác. Không tự đặt target khi không có app.

Thứ tự đi là của dial: các tile đang mở trong cửa sổ Desktop theo thứ tự tile (không có cửa sổ thì
mọi agent theo thứ tự rail — máy này trước, rồi các máy khác theo thứ tự wheel), xoay vòng ở cả hai
đầu. Agent không có tile không bao giờ được bước tới. Chưa có focus thì `next` bắt đầu ở tile đầu,
`previous` ở tile cuối. Chỉ có một agent thì trả ngay snapshot hiện tại, không chuyển gì. Bước chuyển
dùng đúng forward `dial_focus` của dial cáp, nên app quyết định ý nghĩa của việc chọn y như với dial.

Thứ tự kiểm tra: kết quả đã lưu cho `(deviceId,idempotencyKey)` được trả trước, dù thành công hay lỗi,
nên gesture retry là một nấc chứ không phải hai (cùng key nhưng khác `direction` hoặc `focusRevision`
→ `IDEMPOTENCY_CONFLICT`). Chỉ key mới mới được so với revision hiện tại: `focusRevision` cũ trả
`FOCUS_CHANGED` và không chuyển. Kết quả lưu chỉ trong RAM, tối đa 512 mỗi daemon, xoá cũ nhất trước,
và bị xoá khi revoke như receipt.

Lỗi: `NO_AGENTS` khi không có gì để bước tới; `FOCUS_UNAVAILABLE` khi không có cửa sổ Desktop hoặc
app không xác nhận trong hai giây (daemon không retry — đọc `focus.get` trước khi gửi lại);
`INVALID_REQUEST` khi direction, key hoặc revision sai.

Giới hạn target giữ nguyên. Bước chuyển có thể rơi vào tile thuộc máy khác vì cửa sổ có thể đang mở
tile đó; daemon local khi đó báo focus của app rời máy này (`focus:null` với revision mới, hoặc
target remote nếu Desktop công bố ở đây), và `turn.send` tới target đó vẫn trả `MACHINE_MISMATCH`.
OS vẫn chịu trách nhiệm hiển thị rằng target remote chưa được hỗ trợ dispatch. Pairing, transport,
credential và flow gửi task không đổi; CLI cũ không liệt kê `focus.step` trong capabilities của hello.
