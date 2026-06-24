# Kiến trúc — ratelimit-policyd 2.0

Tài liệu thiết kế chi tiết. Tổng quan & quickstart: [README.md](README.md).

## 1. Nguyên tắc nền tảng

1. **Stateless service, state ở Redis.** Mọi bộ đếm nằm trên Redis (chia sẻ giữa mọi replica & mọi node MTA). Nhờ đó đếm **toàn cục** (sửa lỗi "mỗi node một counter" của daemon Perl cũ) và **scale ngang / HA** bằng cách thêm replica.
2. **Fail-open.** Rate-limit là lớp *giảm thiểu*, không phải lớp *chặn tuyệt đối*. Redis/DB lỗi ⇒ trả `DUNNO` + alert, **không bao giờ làm tắc mail**. Các lớp khác (chặn sender bất hợp lệ + quét nội dung SpamAssassin) gánh phần còn lại.
3. **Hot path tối giản.** 1 email = 1 `EVALSHA` Lua atomic (gộp mọi cửa sổ + scope) + ghi audit/anomaly bất đồng bộ. DB chỉ chạm khi cache-miss cấu hình.

## 2. Luồng xử lý 1 email

```
Postfix --(policy delegation, DATA stage)--> PolicyTcpServer
  -> parse key=value (sasl_username|sender, recipient_count, client_address, queue_id)
  -> PolicyService.decide():
       1. blocklist Redis (suspended)?          -> 554 reject  (fast path)
       2. ConfigCache.resolve(email,domain)     -> EffectiveLimits (tier/domain/sender + warm-up)
          - status suspended / domain disabled  -> 554 reject
       3. recipient_count > maxRcptMsg?          -> 554 reject (retry vo ich)
       4. RateLimit.check() (atomic, da cua so)  -> qua? -> tiep; vuot? -> 451 defer + event OVER_QUOTA
       5. Anomaly.evaluate() (velocity/fanout/offhours)
          - du nguong flag -> SenderControl.suspend() -> 554 + alert Telegram
       6. allow -> DUNNO
  -> ghi metrics + event (batched)
```

Quyết định ở **DATA stage** vì lúc đó `recipient_count` đã biết (đếm fan-out của 1 message chính xác). Mọi stage khác (RCPT/...) trả `DUNNO` ngay.

## 3. Bộ đếm trên Redis

### 3.1 Key schema

```
rl:{scope}:{id}:{window}:{bucket}
  scope  = email | domain
  id     = user@dom | dom
  window = m1 | h1 | d1 | mo
  bucket = moc wall-clock: 202606211642 (phut) / 2026062116 (gio) / 20260621 (ngay) / 202606 (thang)
```

Bucket **căn theo đồng hồ tường** (local TZ): "per day" reset lúc nửa đêm địa phương, "per hour" đầu giờ. TTL = thời gian còn lại tới cuối bucket + grace ⇒ key **tự hết hạn**, không cần job reset (bỏ hẳn `calcexpire` của bản cũ).

### 3.2 Atomic check (Lua)

`RL_CHECK` ([policyd/src/redis/lua-scripts.ts](policyd/src/redis/lua-scripts.ts)):
1. Pass 1: với mỗi key, nếu `current + inc > limit` ⇒ trả `{0, i, current, limit}` (reject, **không tăng**).
2. Pass 2: mọi cửa sổ OK ⇒ `INCRBY` từng key, `EXPIRE` khi key mới.

⇒ Mail bị từ chối **không bị tính**; reject theo **index** cửa sổ (không phụ thuộc prefix). Cửa sổ `limit<=0` = không giới hạn ⇒ bỏ qua (không tạo key).

Mỗi email kiểm tra **email-scope** (m1/h1/d1/mo) + **domain-scope** (h1/d1, chỉ khi domain đặt cap) trong **một** lệnh ⇒ giới hạn user và cả tên miền cùng lúc, atomic.

> Tuỳ chọn nâng cao: `GCRA` (token-bucket, mượt hơn fixed-window, không burst ở ranh giới) đã có sẵn trong cùng file, để bật cho "send rate smoothing".

## 4. Phân hạn cấu hình (resolution)

Thứ tự ưu tiên: **sender override > domain override > tier > default**.

- **Tier** (`policy_tier`): hồ sơ giới hạn chung; đa số user kế thừa ⇒ không cần row/user.
- **Domain** (`policy_domain`): kế thừa tier; `perHour/perDay` (nếu đặt) áp cho **cả tên miền** (scope thứ 2, opt-in). `enabled=false` ⇒ chặn domain.
- **Sender** (`policy_sender`): tạo **lazy** lần gửi đầu (status `warmup`), override per-window, `persist`, `status`.

`ConfigCacheService` giữ tier+domain (nhỏ, có giới hạn) trong RAM, refresh 30s + **Redis pub/sub `cfg:reload`** (sửa ở UI ⇒ mọi replica nạp lại tức thì). Sender cache trong **LRU có TTL** (mặc định 100k entry, 60s) ⇒ chỉ sender *đang hoạt động* tốn RAM.

### Warm-up
Sender mới ⇒ tier `warmup` (giới hạn thấp). Sau `WARMUP_DAYS` ⇒ tự lên `default`. Chống account vừa tạo đã blast — đúng cách các nhà cung cấp lớn "ramp-up reputation".

## 5. Chống spam hành vi (anomaly)

`AnomalyService` chạy **sau khi** mail được quota cho qua (tức là volume thật). Counter ngắn hạn trên Redis:
- **velocity**: recipients/phút > ngưỡng (`ANOMALY_BURST_PER_MIN`, hoặc `ANOMALY_OFFHOURS_PER_MIN` trong khung giờ đêm).
- **fanout**: 1 message tới > `ANOMALY_DISTINCT_RCPT_PER_MIN` người (dưới hard-cap nhưng đáng ngờ).
- **offhours**: gửi trong khung `ANOMALY_OFFHOURS_START..END` vượt ngưỡng đêm.
- nhiều **message/phút** cũng tính velocity (blast bằng script).

Mỗi flag tăng counter `an:flags:{email}` (TTL `ANOMALY_WINDOW_SEC`). Đủ `ANOMALY_FLAGS_TO_SUSPEND` ⇒ `SenderControl.suspend()`:
- thêm vào **blocklist Redis** (chặn ngay, kể cả khi DB trễ),
- set `status=suspended` trong DB (UI thấy),
- **bounce cứng 5xx** message hiện tại,
- **alert Telegram/webhook** (de-dupe qua Redis).

Đây là **Lớp 2** (phát hiện hành vi) trong mô hình chống spam outbound nhiều lớp: bắt account thật bị chiếm gửi "đúng luật" nhưng volume/nhịp bất thường.

## 6. High Availability

| Lớp | Cơ chế | Khi hỏng |
|---|---|---|
| Policy service | N replica **stateless** sau HAProxy | HAProxy loại replica chết; state ở Redis nên không mất gì |
| Load balancer | HAProxy (VIP) + DNS service-discovery (`server-template`) | prod: 2 HAProxy + keepalived |
| Redis | **Sentinel**: 1 master + 2 replica + 3 sentinel, tự failover | sentinel bầu master mới; ioredis tự đổi kết nối |
| Config DB | MariaDB (prod: primary/replica) | service chạy bằng cache + fail-open |
| MTA | `default_action=DUNNO` | policy lỗi ⇒ mail vẫn đi |

`server-template pol 6 policyd:10032` trong HAProxy ⇒ scale `--scale policyd=N` được nhận tự động qua DNS Docker, không sửa config.

## 7. Sizing cho hàng triệu user

- **RAM Redis**: chỉ sender *active* có key (TTL). ~5 key/sender × ~100B. 1M active/giờ ≈ **~0.5GB** ⇒ 1 master đủ; Sentinel để HA, Cluster khi cần shard.
- **Throughput**: 1 email = 1 EVALSHA (vài thao tác). Redis 1 core > 100k ops/s ⇒ dư cho hàng nghìn mail/s.
- **DB**: đọc lúc cache-miss cấu hình; audit ghi **batch** (`EventWriterService`, gom 2s/lần, bounded 5000, drop khi đầy) ⇒ không 1 INSERT/mail.
- **Mở rộng tiếp**: Redis Cluster (shard theo key), thêm policyd replica, đẩy event qua Redis Stream + worker nếu cực lớn.

## 8. Failure modes (đã thiết kế chịu lỗi)

| Hỏng | Hành vi |
|---|---|
| Redis down | `rlCheck` ném lỗi ⇒ `decide()` catch ⇒ `FAIL_ACTION=DUNNO` + metric `error`; ioredis tự reconnect |
| DB down | resolve dùng cache cũ / default tier; audit batch bị drop; service vẫn quyết định |
| 1 replica chết | HAProxy health-check loại ra; replica khác phục vụ |
| Master Redis chết | Sentinel failover ⇒ ioredis theo master mới |
| Cấu hình sai (limit 0) | = không giới hạn cửa sổ đó (an toàn, không chặn nhầm) |

## 9. Bản đồ mã nguồn

| Đường dẫn | Vai trò |
|---|---|
| [policyd/src/policy/policy-tcp.server.ts](policyd/src/policy/policy-tcp.server.ts) | Giao thức Postfix policy (parse line, allowlist CIDR, reuse connection) |
| [policyd/src/policy/policy.service.ts](policyd/src/policy/policy.service.ts) | Logic quyết định (6 bước) |
| [policyd/src/policy/ratelimit.service.ts](policyd/src/policy/ratelimit.service.ts) | Dựng cửa sổ + gọi Lua + leaderboard |
| [policyd/src/policy/windows.ts](policyd/src/policy/windows.ts) | Bucket/TTL căn đồng hồ |
| [policyd/src/policy/config-cache.service.ts](policyd/src/policy/config-cache.service.ts) | Resolve tier/domain/sender + warm-up + pub/sub |
| [policyd/src/policy/anomaly.service.ts](policyd/src/policy/anomaly.service.ts) | Phát hiện hành vi bất thường |
| [policyd/src/policy/sender-control.service.ts](policyd/src/policy/sender-control.service.ts) | Suspend/unsuspend (blocklist + DB + alert) |
| [policyd/src/redis/redis.service.ts](policyd/src/redis/redis.service.ts) | ioredis Sentinel + Lua + leaderboard + pub/sub |
| [policyd/src/admin/](policyd/src/admin/) | REST API + JWT (tiers/domains/senders/events/dashboard) |
| [policyd/src/metrics/](policyd/src/metrics/) · [notify/](policyd/src/notify/) | Prometheus · Telegram/webhook |

---

# Architecture — postfix-outbound-ratelimiter

Detailed design document. Overview & quickstart: [README.md](README.md).

## 1. Core Principles

1. **Stateless service, state in Redis.** All counters live in Redis (shared across all replicas and all MTA nodes). This enables **global counting** (fixes the "one counter per node" bug of the legacy Perl daemon) and **horizontal scaling / HA** by adding replicas.
2. **Fail-open.** Rate limiting is a *mitigation* layer, not an *absolute block* layer. Redis/DB failure ⇒ return `DUNNO` + alert, **never block mail**. Other layers (blocking invalid senders + SpamAssassin content scanning) cover the rest.
3. **Minimal hot path.** 1 email = 1 `EVALSHA` Lua atomic call (combining all windows + scopes) + async audit/anomaly writes. DB is only touched on config cache-miss.

## 2. Per-Email Processing Flow

```
Postfix --(policy delegation, DATA stage)--> PolicyTcpServer
  -> parse key=value (sasl_username|sender, recipient_count, client_address, queue_id)
  -> PolicyService.decide():
       1. blocklist Redis (suspended)?            -> 554 reject  (fast path)
       2. ConfigCache.resolve(email,domain)       -> EffectiveLimits (tier/domain/sender + warm-up)
          - status suspended / domain disabled    -> 554 reject
       3. recipient_count > maxRcptMsg?            -> 554 reject (no point retrying)
       4. RateLimit.check() (atomic, multi-window) -> pass? -> continue; exceed? -> 451 defer + OVER_QUOTA event
       5. Anomaly.evaluate() (velocity/fanout/offhours)
          - enough flags -> SenderControl.suspend() -> 554 + Telegram alert
       6. allow -> DUNNO
  -> write metrics + event (batched)
```

Decisions at the **DATA stage** because `recipient_count` is known at that point (accurate fan-out count per message). All other stages (RCPT/...) return `DUNNO` immediately.

## 3. Redis Counters

### 3.1 Key Schema

```
rl:{scope}:{id}:{window}:{bucket}
  scope  = email | domain
  id     = user@dom | dom
  window = m1 | h1 | d1 | mo
  bucket = wall-clock aligned: 202606211642 (minute) / 2026062116 (hour) / 20260621 (day) / 202606 (month)
```

Bucket **aligned to wall clock** (local TZ): "per day" resets at local midnight, "per hour" at the top of the hour. TTL = time remaining to end of bucket + grace ⇒ keys **expire automatically**, no reset job needed (eliminates `calcexpire` from the old version).

### 3.2 Atomic Check (Lua)

`RL_CHECK` ([policyd/src/redis/lua-scripts.ts](policyd/src/redis/lua-scripts.ts)):
1. Pass 1: for each key, if `current + inc > limit` ⇒ return `{0, i, current, limit}` (reject, **no increment**).
2. Pass 2: all windows OK ⇒ `INCRBY` each key, `EXPIRE` on new keys.

⇒ Rejected mail is **not counted**; reject reported by **window index** (not prefix-dependent). Windows with `limit<=0` = unlimited ⇒ skipped (no key created).

Each email checks **email-scope** (m1/h1/d1/mo) + **domain-scope** (h1/d1, only when domain has a cap) in **one** command ⇒ user and domain limits enforced simultaneously, atomically.

> Advanced option: `GCRA` (token-bucket, smoother than fixed-window, no burst at window boundaries) is available in the same file, ready to enable for "send rate smoothing".

## 4. Configuration Resolution

Priority order: **sender override > domain override > tier > default**.

- **Tier** (`policy_tier`): shared limit profile; most users inherit it ⇒ no per-user rows needed.
- **Domain** (`policy_domain`): inherits tier; `perHour/perDay` (if set) applies to the **entire domain** (second scope, opt-in). `enabled=false` ⇒ block the domain.
- **Sender** (`policy_sender`): created **lazily** on first send (status `warmup`), can override per-window, `persist`, `status`.

`ConfigCacheService` keeps tier+domain (small, bounded) in RAM, refreshed every 30s + **Redis pub/sub `cfg:reload`** (UI change ⇒ all replicas reload immediately). Sender cache uses an **LRU with TTL** (default 100k entries, 60s) ⇒ only *active* senders consume RAM.

### Warm-up
New sender ⇒ `warmup` tier (low limits). After `WARMUP_DAYS` ⇒ auto-promoted to `default`. Prevents freshly created accounts from bulk-sending — mirrors how large providers handle reputation ramp-up.

## 5. Behavioral Anti-Spam (Anomaly Detection)

`AnomalyService` runs **after** mail passes quota (on actual volume). Short-term counters in Redis:
- **velocity**: recipients/minute > threshold (`ANOMALY_BURST_PER_MIN`, or `ANOMALY_OFFHOURS_PER_MIN` during the nighttime window).
- **fanout**: 1 message to > `ANOMALY_DISTINCT_RCPT_PER_MIN` unique recipients (below hard cap but suspicious).
- **offhours**: sending during `ANOMALY_OFFHOURS_START..END` exceeding the night threshold.
- high **messages/minute** also counts as velocity (script-driven blast).

Each flag increments counter `an:flags:{email}` (TTL `ANOMALY_WINDOW_SEC`). Reaching `ANOMALY_FLAGS_TO_SUSPEND` ⇒ `SenderControl.suspend()`:
- adds to **Redis blocklist** (blocks immediately, even before DB write),
- sets `status=suspended` in DB (visible in UI),
- **hard bounce 5xx** the current message,
- **Telegram/webhook alert** (de-duplicated via Redis).

This is **Layer 2** (behavioral detection) in a multi-layer outbound anti-spam model: catches legitimate accounts that have been compromised and are sending within quota but with abnormal volume or cadence.

## 6. High Availability

| Layer | Mechanism | On failure |
|---|---|---|
| Policy service | N **stateless** replicas behind HAProxy | HAProxy removes dead replica; state in Redis, nothing lost |
| Load balancer | HAProxy (VIP) + DNS service-discovery (`server-template`) | prod: 2 HAProxy + keepalived |
| Redis | **Sentinel**: 1 master + 2 replicas + 3 sentinels, auto-failover | sentinel elects new master; ioredis follows |
| Config DB | MariaDB (prod: primary/replica) | service runs on stale cache + fail-open |
| MTA | `default_action=DUNNO` | policy failure ⇒ mail still passes |

`server-template pol 6 policyd:10032` in HAProxy ⇒ `--scale policyd=N` is auto-discovered via Docker DNS, no config change needed.

## 7. Sizing for Millions of Users

- **Redis RAM**: only *active* senders have keys (TTL). ~5 keys/sender × ~100 B. 1M active/hour ≈ **~0.5 GB** ⇒ single master is sufficient; Sentinel for HA, Cluster for sharding.
- **Throughput**: 1 email = 1 EVALSHA (a few ops). Redis on 1 core > 100k ops/s ⇒ well above thousands of mails/s.
- **DB**: reads on config cache-miss; audit writes are **batched** (`EventWriterService`, flushed every 2s, bounded at 5000, dropped when full) ⇒ no 1 INSERT/mail.
- **Further scaling**: Redis Cluster (shard by key), add policyd replicas, push events via Redis Stream + worker for extreme volume.

## 8. Failure Modes (designed for resilience)

| Failure | Behavior |
|---|---|
| Redis down | `rlCheck` throws ⇒ `decide()` catches ⇒ `FAIL_ACTION=DUNNO` + error metric; ioredis auto-reconnects |
| DB down | resolve uses stale cache / default tier; audit batch dropped; service still makes decisions |
| 1 replica dies | HAProxy health-check removes it; other replicas serve |
| Redis master dies | Sentinel failover ⇒ ioredis follows new master |
| Misconfigured limit (0) | = no limit for that window (safe, won't block incorrectly) |

## 9. Source Map

| Path | Role |
|---|---|
| [policyd/src/policy/policy-tcp.server.ts](policyd/src/policy/policy-tcp.server.ts) | Postfix policy protocol (parse key=value, CIDR allowlist, connection reuse) |
| [policyd/src/policy/policy.service.ts](policyd/src/policy/policy.service.ts) | Decision logic (6 steps) |
| [policyd/src/policy/ratelimit.service.ts](policyd/src/policy/ratelimit.service.ts) | Build windows + call Lua + leaderboard |
| [policyd/src/policy/windows.ts](policyd/src/policy/windows.ts) | Wall-clock aligned buckets/TTL |
| [policyd/src/policy/config-cache.service.ts](policyd/src/policy/config-cache.service.ts) | Resolve tier/domain/sender + warm-up + pub/sub |
| [policyd/src/policy/anomaly.service.ts](policyd/src/policy/anomaly.service.ts) | Behavioral anomaly detection |
| [policyd/src/policy/sender-control.service.ts](policyd/src/policy/sender-control.service.ts) | Suspend/unsuspend (blocklist + DB + alert) |
| [policyd/src/redis/redis.service.ts](policyd/src/redis/redis.service.ts) | ioredis Sentinel + Lua + leaderboard + pub/sub |
| [policyd/src/admin/](policyd/src/admin/) | REST API + JWT (tiers/domains/senders/events/dashboard) |
| [policyd/src/metrics/](policyd/src/metrics/) · [notify/](policyd/src/notify/) | Prometheus · Telegram/webhook |
