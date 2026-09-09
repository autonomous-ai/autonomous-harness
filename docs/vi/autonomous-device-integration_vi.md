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

Wire dùng nguyên e2e_* gốc role device, CI b:device. App outer autonomous_device_request/result/event
vẫn pairwise encrypted với empty dbSessionId AAD; helper relay.ts chỉ là adapter ứng dụng dùng chung
crypto, không kết nối backend. Request agents.list/status/recap/turn.send/turn.stop/question.answer/
receipt.get giữ target rõ và receipt/dedupe. Không replay mutation khi mất kết nối; unknown không
có nghĩa chưa gửi. Cache512/ring500 và schema đầy đủ ở [bản EN](../autonomous-device-integration.md).

Typecheck/focused test đã đạt gồm chỉ chọn discovery, retry socket mới, chờ authenticated identity
và từ chối reconnect giả mạo. Real mDNS/direct Go OS ↔ CLI đã đạt khi backend chưa từng kết nối: discovery SRV, sai mã/retry,
PAKE/session, encrypted list/send/dedupe, restart/reconnect và revoke/unpair. Status chỉ đếm direct
session đã xác thực và app-ready, không đếm socket thô. Full CLI đã đạt với
`npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000`: 144 file / 1.871 test pass,
5 file / 50 test skip; `npm run typecheck` đạt. Lần chạy deadline mặc định 5 giây bị timeout ở
các test password/scrypt sẵn có khi máy chịu tải. Chỉ đổi deadline qua lệnh chạy serial, không
sửa test hoặc cấu hình để né lỗi. Không deploy hoặc pair thiết bị thật.
