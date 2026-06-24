# Triển khai & vận hành — ratelimit-policyd 2.0

Tổng quan: [README.md](README.md) · Thiết kế: [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Yêu cầu

- Docker + Docker Compose v2 (đã test với Docker 29, Compose v5).
- 1 host cho demo/SMB; cho HA thật: tách Redis/DB/HAProxy ra nhiều host (xem §6).

## 2. Khởi chạy

```bash
cd postfix-outbound-ratelimiter
cp .env.example .env
# BAT BUOC sua: DB_PASSWORD, DB_ROOT_PASSWORD, ADMIN_PASSWORD, JWT_SECRET (>=32 ky tu), GRAFANA_PASSWORD
docker compose up -d --build --scale policyd=3
docker compose ps
```

Lần đầu mỗi replica tự `prisma db push` (tạo bảng) và `RUN_SEED=true` seed 4 tier (`warmup/default/business/vip`). Upsert idempotent nên 3 replica seed song song vô hại.

Cổng publish ra host:
- **`10032`** (policy, qua HAProxy) — port **duy nhất** mở ra mạng cho MTA/PMG. Hạn chế thêm bằng `POLICY_LISTEN` (vd `10.0.0.50` hoặc `127.0.0.1`).
- `8080` (UI/API), `8404` (stats), `9090` (Prometheus), `3000` (Grafana) — đều bind **`127.0.0.1`** (loopback), truy cập qua SSH tunnel / reverse proxy TLS. Đổi `UI_PORT`/`GRAFANA_PORT`/... trong `.env` nếu trùng cổng.
- db, redis-master/replica, sentinels, policyd: **không** publish — chỉ kết nối nội bộ trên network `rlnet` theo tên service.

## 3. Đấu nối Postfix / PMG

Quyết định ở **DATA stage** (cần `recipient_count`). Trỏ vào **HAProxy** (VIP), không trỏ thẳng replica.

### PMG (Proxmox Mail Gateway)
Sửa template rồi sync:

```cf
# /etc/pmg/templates/main.cf.in
smtpd_restriction_classes = ratelimitpolicyd
ratelimitpolicyd = check_policy_service { inet:10.0.0.50:10032, timeout=10s, default_action=DUNNO }

smtpd_data_restrictions =
        reject_unauth_pipelining,
        ratelimitpolicyd,
        permit
```

```bash
pmgconfig sync --restart 1
```

`10.0.0.50` = host chạy HAProxy (mạng nội bộ). `default_action=DUNNO` = **fail-open**: policy không tới được thì cho mail qua. Cổng outbound (vd 26) nếu override `smtpd_data_restrictions` thì thêm class vào đó.

### Postfix thường

```cf
# main.cf
smtpd_policy_service_default_action = DUNNO
smtpd_policy_service_timeout = 10s
smtpd_data_restrictions = reject_unauth_pipelining,
    check_policy_service inet:10.0.0.50:10032, permit
```

Kiểm tra nhanh không cần MTA:

```bash
printf 'protocol_state=DATA\nsasl_username=u@dom\nrecipient_count=1\n\n' | nc 10.0.0.50 10032
# -> action=DUNNO
```

## 4. Quản trị (UI + API)

- UI: `http://<host>:8080` — đăng nhập `ADMIN_USER`/`ADMIN_PASSWORD`. Tab Dashboard/Tiers/Domains/Senders/Events.
- API (JWT Bearer):

```bash
TOKEN=$(curl -s -X POST http://HOST:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"..."}' | jq -r .token)

# dat limit theo ten mien (vd toan domain abc.com toi da 1000/gio, 10000/ngay)
curl -X POST http://HOST:8080/api/domains -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"domain":"abc.com","perHour":1000,"perDay":10000,"enabled":true}'

# nang 1 user len tier business
curl -X PUT http://HOST:8080/api/senders/vip@abc.com -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"tierId":3,"persist":true}'

# suspend / unsuspend thu cong
curl -X POST http://HOST:8080/api/senders/bad@abc.com/suspend -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"spam complaint"}'
```

Mọi thay đổi phát `cfg:reload` qua Redis ⇒ mọi replica áp dụng **tức thì**.

## 5. Giám sát

- **Grafana** `:3000` tự nạp dashboard "ratelimit-policyd — Outbound Mail Rate Limiting" (decisions/s, over-quota theo cửa sổ, anomaly, suspensions, p50/95/99 latency, recipients/s, RAM/eventloop).
- **Prometheus** `:9090` scrape mọi replica qua DNS (`--scale` tự nhận).
- **Cảnh báo**: đặt `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` và/hoặc `ALERT_WEBHOOK_URL` (chat/automation flow) ⇒ báo khi suspend / Redis down / spike. De-dupe `ALERT_MIN_INTERVAL_SEC`.

Metric chính (xem [metrics.service.ts](policyd/src/metrics/metrics.service.ts)): `policyd_decisions_total{action}`, `policyd_over_quota_total{window,scope}`, `policyd_anomaly_flags_total{reason}`, `policyd_suspensions_total`, `policyd_redis_up`, `policyd_active_senders`.

## 6. Hardening cho production {#hardening}

> Mặc định compose tối ưu cho **demo nội bộ**. Trước khi public:

1. **Secrets**: chuyển `.env` sang **Docker/K8s secrets**; không commit `.env`; xoay `JWT_SECRET` và mọi mật khẩu định kỳ. Không hardcode secret trong image/source.
2. **Redis auth**: bật `requirepass`/`masterauth` trong [redis/master.conf](redis/master.conf) + [replica.conf](redis/replica.conf), `sentinel auth-pass` trong [sentinel.conf](redis/sentinel.conf), và `REDIS_PASSWORD` cho service.
3. **Mạng**: cổng `10032` chỉ mở cho HAProxy; HAProxy↔policyd↔Redis↔DB trong mạng nội bộ/overlay. Không expose Redis/DB ra ngoài. Đặt `POLICY_ALLOW_CIDRS` nếu không có HAProxy chắn.
4. **HA thật (đa host)**: chạy Redis Sentinel + MariaDB primary/replica trên host riêng; policyd nhiều host (Swarm/K8s) — `deploy.replicas`; **2 HAProxy + keepalived** cho VIP. Sentinel dùng `resolve-hostnames yes` (đã bật) khi tên ổn định; đa host nên pin IP/hostname DNS.
5. **DB migrations**: production dùng `prisma migrate` (tạo `prisma/migrations/`) thay vì `db push`; entrypoint tự `migrate deploy` khi có thư mục migrations. Đặt `RUN_SEED=false` sau lần đầu.
6. **TLS UI**: đặt UI sau reverse proxy TLS (hoặc HAProxy `bind :443 ssl`). JWT đã HS256 + so khớp mật khẩu constant-time; cân nhắc đổi `ADMIN_*` sang IdP/OIDC nếu cần.
7. **Tài nguyên**: đặt `deploy.resources.limits`, `maxmemory` Redis theo §7 ARCHITECTURE, `--max-connections` MariaDB.

### Ghi chú bảo mật
- Endpoint admin nên đặt sau rate-limit/WAF; chỉ mở loopback hoặc sau reverse proxy TLS.
- Auth: UI JWT (HS256) + so khớp mật khẩu constant-time; bật helmet (đã có). Cân nhắc RBAC/OIDC nếu cần nhiều người dùng.
- Giữ file `*.sh/*.conf/Dockerfile/.env/*.yml` ở dạng ASCII-only để tránh lỗi locale trong Alpine/distroless/systemd.

## 6b. Theo dõi nâng cao: observe-mode (A) + bounce-rate feedback (B)

### A. Observe -> Enforce (an toàn khi bật chống spam)
- Mặc định `ANOMALY_MODE=observe`: hệ thống **phát hiện + tính risk score + alert** nhưng **không** suspend. Mail bất thường vẫn đi (`DUNNO`), chỉ ghi event `OBSERVE` + metric `policyd_observe_would_suspend_total`.
- Theo dõi vài ngày: UI Dashboard → chọn window **"Risk score"** xem ai điểm cao; thẻ **Mode / Would-suspend / Bounce flags**; Grafana panel anomaly.
- Hiệu chỉnh `ANOMALY_BURST_PER_MIN`, `ANOMALY_DISTINCT_RCPT_PER_MIN`, `ANOMALY_FLAGS_TO_SUSPEND` cho khớp tải thật.
- Khi yên tâm: đặt `ANOMALY_MODE=enforce` → từ đó vượt ngưỡng sẽ **auto-suspend + bounce 554**.

### B. Bounce-rate feedback (tín hiệu spam mạnh nhất)
Hệ thống chỉ thấy mail ở DATA stage (trước khi gửi); kết quả **bounce/spam** nằm trong log MTA. Một **log shipper** đẩy kết quả về API để tính tỉ lệ bounce theo sender.

1. Đặt secret: `FEEDBACK_TOKEN=<chuoi-ngau-nhien>` (và `BOUNCE_RATE_MIN_SAMPLE`, `BOUNCE_RATE_THRESHOLD`, `FEEDBACK_WINDOW_HOURS`).
2. Chạy shipper mẫu cạnh MTA/PMG (đọc `/var/log/mail.log`, map queue-id -> sender, POST kết quả):

```bash
FEEDBACK_URL=http://<haproxy>:8080/api/feedback/delivery \
FEEDBACK_TOKEN=<chuoi-ngau-nhien> \
MAIL_LOG=/var/log/mail.log \
python3 scripts/mail_feedback_shipper.py
```

3. Cơ chế: mỗi sender giữ counter `sent` và `bounce/spam` trong cửa sổ `FEEDBACK_WINDOW_HOURS`. Khi `sent >= MIN_SAMPLE` và `(bounce+spam)/sent >= THRESHOLD` ⇒ raise flag ⇒ **suspend (enforce)** hoặc **alert (observe)**. Đây là **Lớp 2** (reputation) — bắt account "gửi đúng luật" nhưng bị phía nhận từ chối nhiều (hostname giả, domain không deliverable, nội dung spam...).

API thủ công (test nhanh):
```bash
curl -X POST http://<host>:8080/api/feedback/delivery \
  -H 'x-feedback-token: <chuoi-ngau-nhien>' -H 'content-type: application/json' \
  -d '{"events":[{"sender":"u@dom","status":"bounced","dsn":"5.7.1","text":"spam blocked"}]}'
# xem tinh trang: GET /api/dashboard/feedback/u@dom (JWT)
```

> Lưu ý khớp khóa: shipper nên gửi đúng định danh mà policy dùng (`sasl_username` nếu có, nếu không thì envelope `sender`) để suspend đúng tài khoản.

## 7. Smoke test (tự kiểm chứng) {#smoke-test}

Không cần MTA, dựng Redis+MariaDB rồi chạy service đã build:

```bash
cd postfix-outbound-ratelimiter/policyd
npm install && npx prisma generate && npm run build

docker run -d --name rl-redis -p 6390:6379 redis:7-alpine
docker run -d --name rl-db -p 3307:3306 \
  -e MARIADB_DATABASE=policyd -e MARIADB_USER=policyd \
  -e MARIADB_PASSWORD=testpass -e MARIADB_ROOT_PASSWORD=rootpass mariadb:11
# doi MariaDB ready (~10s)

export DATABASE_URL="mysql://policyd:testpass@127.0.0.1:3307/policyd"
export REDIS_URL="redis://127.0.0.1:6390" REDIS_SENTINELS=""
export ADMIN_USER=admin ADMIN_PASSWORD=adminpass
export JWT_SECRET="dev_secret_at_least_32_characters_long__"
export POLICY_BIND=127.0.0.1 HTTP_PORT=18080 METRICS_PORT=19100
export POLICY_ALLOW_CIDRS="127.0.0.1/32" RUN_MIGRATIONS=false TZ=Asia/Ho_Chi_Minh
npx prisma db push --skip-generate && node dist/seed.js
node dist/main.js &

# warmup perMin=5 -> mail 1..5 DUNNO, 6..7 = 451
for i in $(seq 1 7); do
  printf "protocol_state=DATA\nsasl_username=u1@x.com\nsender=u1@x.com\nrecipient_count=1\nqueue_id=Q$i\nclient_address=203.0.113.9\n\n" | nc -w1 127.0.0.1 10032
done
```

Kết quả mong đợi (đã verify trong môi trường build):

| Test | Kết quả |
|---|---|
| 7 mail warmup (5/phút) | 5×`DUNNO`, 2×`451` |
| message 25 người nhận (cap 20) | `554 Too many recipients` |
| admin suspend → gửi lại | `554 ...suspected abuse` |
| sửa tier qua API | áp dụng ngay (pub/sub) |
| login sai / không token | `401` |

Hoặc chạy **smoke test in-process** cho A (observe) + B (feedback) — gọi thẳng service, không cần MTA (cần 2 container Redis/MariaDB ở trên + `npm run build`):

```bash
TESTMODE=observe node test/e2e-smoke.js   # observe: flag + risk, KHONG suspend
TESTMODE=enforce node test/e2e-smoke.js   # enforce + bounce-rate -> suspend -> 554
```

Kết quả đã verify: observe = 4 mail `DUNNO` + risk=55 (không suspend); enforce = 4 gửi + 3 bounce (75% > 50%) → **suspend** → mail kế `554`; token feedback sai → `401`.

Dọn dẹp: `docker rm -f rl-redis rl-db`.

## 7b. Sự cố thường gặp

- **Admin API trả `500` ở /api/tiers,/domains,/senders,/events (nhưng login OK):** bảng DB chưa tạo hoặc Prisma query engine sai. Bản hiện tại đã sửa (Prisma CLI nằm trong runtime deps + `binaryTargets` khớp OpenSSL 3.0). Nếu gặp lại sau khi đổi base image: **rebuild** `docker compose build --no-cache policyd && docker compose up -d`, rồi xem `docker compose logs policyd` phải thấy `db push ... in sync` + `seed ... ok`, không có `Query Engine ... debian-openssl`.
- **policyd restart-loop:** thường do `db` chưa healthy hoặc `DATABASE_URL` sai - kiểm tra `docker compose logs db` và biến `DB_PASSWORD`.
- **`401` ở /api/feedback/delivery:** thiếu/đặt sai header `X-Feedback-Token` so với `FEEDBACK_TOKEN`.

## 8. Vận hành thường ngày

- **Scale**: `docker compose up -d --scale policyd=6` (HAProxy + Prometheus tự nhận qua DNS).
- **Xem ai sắp chạm quota**: UI Dashboard → "Top near quota", hoặc `GET /api/dashboard/top?window=h1`.
- **Điều tra spam**: UI Events lọc `action=SUSPEND/OVER_QUOTA`, hoặc query `policy_event` theo `email`.
- **Gỡ nhầm suspend**: UI Senders → Unsuspend (xoá blocklist + set active).
- **Đổi giới hạn giờ cao điểm**: tạo `policy_schedule` (scope/ref/giờ/multiplier) — khung dữ liệu đã có; nhân hệ số áp ở bước resolve (mở rộng tiếp nếu cần lịch động).
- **Backup**: volume `dbdata` (cấu hình + audit). Redis là ephemeral (trừ blocklist — AOF everysec đã bật).

---

# Deployment & Operations — postfix-outbound-ratelimiter

Overview: [README.md](README.md) · Design: [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Requirements

- Docker + Docker Compose v2 (tested with Docker 29, Compose v5).
- 1 host for demo/SMB; for real HA: separate Redis/DB/HAProxy across multiple hosts (see §6).

## 2. Quick Start

```bash
cd postfix-outbound-ratelimiter
cp .env.example .env
# REQUIRED: set DB_PASSWORD, DB_ROOT_PASSWORD, ADMIN_PASSWORD, JWT_SECRET (>=32 chars), GRAFANA_PASSWORD
docker compose up -d --build --scale policyd=3
docker compose ps
```

On first run, each replica runs `prisma db push` (creates tables) and `RUN_SEED=true` seeds 4 tiers (`warmup/default/business/vip`). Upsert is idempotent so 3 replicas seeding in parallel is safe.

Published ports:
- **`10032`** (policy, via HAProxy) — the **only** port exposed to the network for MTA/PMG. Restrict further with `POLICY_LISTEN` (e.g. `10.0.0.50` or `127.0.0.1`).
- `8080` (UI/API), `8404` (stats), `9090` (Prometheus), `3000` (Grafana) — all bound to **`127.0.0.1`** (loopback); access via SSH tunnel or TLS reverse proxy. Change `UI_PORT`/`GRAFANA_PORT`/... in `.env` if there are port conflicts.
- db, redis-master/replica, sentinels, policyd: **not published** — internal connections only on the `rlnet` network by service name.

## 3. Connecting Postfix / PMG

Decisions at the **DATA stage** (requires `recipient_count`). Point to **HAProxy** (VIP), not directly to a replica.

### PMG (Proxmox Mail Gateway)
Edit the template and sync:

```cf
# /etc/pmg/templates/main.cf.in
smtpd_restriction_classes = ratelimitpolicyd
ratelimitpolicyd = check_policy_service { inet:10.0.0.50:10032, timeout=10s, default_action=DUNNO }

smtpd_data_restrictions =
        reject_unauth_pipelining,
        ratelimitpolicyd,
        permit
```

```bash
pmgconfig sync --restart 1
```

`10.0.0.50` = host running HAProxy (internal network). `default_action=DUNNO` = **fail-open**: if the policy service is unreachable, mail passes through. For the outbound port (e.g. 26) if overriding `smtpd_data_restrictions`, add the class there too.

### Plain Postfix

```cf
# main.cf
smtpd_policy_service_default_action = DUNNO
smtpd_policy_service_timeout = 10s
smtpd_data_restrictions = reject_unauth_pipelining,
    check_policy_service inet:10.0.0.50:10032, permit
```

Quick test without an MTA:

```bash
printf 'protocol_state=DATA\nsasl_username=u@dom\nrecipient_count=1\n\n' | nc 10.0.0.50 10032
# -> action=DUNNO
```

## 4. Administration (UI + API)

- UI: `http://<host>:8080` — log in with `ADMIN_USER`/`ADMIN_PASSWORD`. Tabs: Dashboard / Tiers / Domains / Senders / Events.
- API (JWT Bearer):

```bash
TOKEN=$(curl -s -X POST http://HOST:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"..."}' | jq -r .token)

# set domain-level limit (e.g. abc.com: max 1000/hour, 10000/day)
curl -X POST http://HOST:8080/api/domains -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"domain":"abc.com","perHour":1000,"perDay":10000,"enabled":true}'

# upgrade a user to business tier
curl -X PUT http://HOST:8080/api/senders/vip@abc.com -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"tierId":3,"persist":true}'

# manual suspend / unsuspend
curl -X POST http://HOST:8080/api/senders/bad@abc.com/suspend -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"spam complaint"}'
```

All changes emit `cfg:reload` via Redis ⇒ all replicas apply the change **immediately**.

## 5. Monitoring

- **Grafana** `:3000` auto-loads the "postfix-outbound-ratelimiter — Outbound Mail Rate Limiting" dashboard (decisions/s, over-quota by window, anomaly, suspensions, p50/95/99 latency, recipients/s, RAM/eventloop).
- **Prometheus** `:9090` scrapes all replicas via DNS (`--scale` auto-discovery).
- **Alerts**: set `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` and/or `ALERT_WEBHOOK_URL` ⇒ notifies on suspend / Redis down / spikes. De-duplicate with `ALERT_MIN_INTERVAL_SEC`.

Key metrics (see [metrics.service.ts](policyd/src/metrics/metrics.service.ts)): `policyd_decisions_total{action}`, `policyd_over_quota_total{window,scope}`, `policyd_anomaly_flags_total{reason}`, `policyd_suspensions_total`, `policyd_redis_up`, `policyd_active_senders`.

## 6. Production Hardening {#hardening}

> Default compose is optimized for **internal demo**. Before going public:

1. **Secrets**: move `.env` to **Docker/K8s secrets**; do not commit `.env`; rotate `JWT_SECRET` and all passwords regularly. Never hardcode secrets in image/source.
2. **Redis auth**: enable `requirepass`/`masterauth` in [redis/master.conf](redis/master.conf) + [replica.conf](redis/replica.conf), `sentinel auth-pass` in [sentinel.conf](redis/sentinel.conf), and set `REDIS_PASSWORD` for the service.
3. **Network**: port `10032` only open to HAProxy; HAProxy↔policyd↔Redis↔DB on internal/overlay network. Do not expose Redis/DB externally. Set `POLICY_ALLOW_CIDRS` if no HAProxy in front.
4. **True HA (multi-host)**: run Redis Sentinel + MariaDB primary/replica on dedicated hosts; policyd on multiple hosts (Swarm/K8s) — `deploy.replicas`; **2 HAProxy + keepalived** for VIP. Sentinel uses `resolve-hostnames yes` (already enabled) when hostnames are stable; pin IP/hostname DNS for multi-host.
5. **DB migrations**: production should use `prisma migrate` (creates `prisma/migrations/`) instead of `db push`; entrypoint auto-runs `migrate deploy` when the migrations directory exists. Set `RUN_SEED=false` after first run.
6. **TLS for UI**: put UI behind TLS reverse proxy (or HAProxy `bind :443 ssl`). JWT is HS256 + constant-time password comparison; consider switching `ADMIN_*` to IdP/OIDC for multi-user setups.
7. **Resources**: set `deploy.resources.limits`, Redis `maxmemory` per §7 ARCHITECTURE, MariaDB `--max-connections`.

### Security notes
- Admin endpoints should be behind rate-limiting/WAF; bind to loopback or behind TLS reverse proxy only.
- Auth: UI JWT (HS256) + constant-time password match; helmet enabled. Consider RBAC/OIDC for multi-user environments.
- Keep `*.sh/*.conf/Dockerfile/.env/*.yml` as ASCII-only to avoid locale issues in Alpine/distroless/systemd.

## 6b. Advanced Monitoring: observe-mode (A) + bounce-rate feedback (B)

### A. Observe → Enforce (safe rollout for anti-spam)
- Default `ANOMALY_MODE=observe`: the system **detects + scores risk + alerts** but **does not** suspend. Anomalous mail still passes (`DUNNO`); only an `OBSERVE` event and `policyd_observe_would_suspend_total` metric are recorded.
- Monitor for a few days: UI Dashboard → **"Risk score"** window to see high-risk senders; **Mode / Would-suspend / Bounce flags** tabs; Grafana anomaly panel.
- Tune `ANOMALY_BURST_PER_MIN`, `ANOMALY_DISTINCT_RCPT_PER_MIN`, `ANOMALY_FLAGS_TO_SUSPEND` to match real traffic.
- When confident: set `ANOMALY_MODE=enforce` → threshold violations will **auto-suspend + bounce 554**.

### B. Bounce-rate feedback (strongest spam signal)
The system only sees mail at the DATA stage (before sending); **bounce/spam** outcomes live in MTA logs. A **log shipper** pushes results back to the API to track per-sender bounce rates.

1. Set secret: `FEEDBACK_TOKEN=<random-string>` (and `BOUNCE_RATE_MIN_SAMPLE`, `BOUNCE_RATE_THRESHOLD`, `FEEDBACK_WINDOW_HOURS`).
2. Run the sample shipper alongside your MTA/PMG (reads `/var/log/mail.log`, maps queue-id → sender, POSTs results):

```bash
FEEDBACK_URL=http://<haproxy>:8080/api/feedback/delivery \
FEEDBACK_TOKEN=<random-string> \
MAIL_LOG=/var/log/mail.log \
python3 scripts/mail_feedback_shipper.py
```

3. Mechanism: each sender maintains `sent` and `bounce/spam` counters within a `FEEDBACK_WINDOW_HOURS` window. When `sent >= MIN_SAMPLE` and `(bounce+spam)/sent >= THRESHOLD` ⇒ raises a flag ⇒ **suspend (enforce)** or **alert (observe)**. This is **Layer 2** (reputation) — catches accounts sending within quota but being rejected by recipients (fake hostnames, undeliverable domains, spam content...).

Manual API test:
```bash
curl -X POST http://<host>:8080/api/feedback/delivery \
  -H 'x-feedback-token: <random-string>' -H 'content-type: application/json' \
  -d '{"events":[{"sender":"u@dom","status":"bounced","dsn":"5.7.1","text":"spam blocked"}]}'
# check status: GET /api/dashboard/feedback/u@dom (JWT)
```

> Key matching: the shipper should send the same identifier the policy uses (`sasl_username` if present, otherwise envelope `sender`) to ensure the correct account is suspended.

## 7. Smoke Test (self-verification) {#smoke-test}

No MTA needed — spin up Redis+MariaDB then run the built service:

```bash
cd postfix-outbound-ratelimiter/policyd
npm install && npx prisma generate && npm run build

docker run -d --name rl-redis -p 6390:6379 redis:7-alpine
docker run -d --name rl-db -p 3307:3306 \
  -e MARIADB_DATABASE=policyd -e MARIADB_USER=policyd \
  -e MARIADB_PASSWORD=testpass -e MARIADB_ROOT_PASSWORD=rootpass mariadb:11
# wait for MariaDB to be ready (~10s)

export DATABASE_URL="mysql://policyd:testpass@127.0.0.1:3307/policyd"
export REDIS_URL="redis://127.0.0.1:6390" REDIS_SENTINELS=""
export ADMIN_USER=admin ADMIN_PASSWORD=adminpass
export JWT_SECRET="dev_secret_at_least_32_characters_long__"
export POLICY_BIND=127.0.0.1 HTTP_PORT=18080 METRICS_PORT=19100
export POLICY_ALLOW_CIDRS="127.0.0.1/32" RUN_MIGRATIONS=false TZ=UTC
npx prisma db push --skip-generate && node dist/seed.js
node dist/main.js &

# warmup perMin=5 -> messages 1..5 DUNNO, 6..7 = 451
for i in $(seq 1 7); do
  printf "protocol_state=DATA\nsasl_username=u1@x.com\nsender=u1@x.com\nrecipient_count=1\nqueue_id=Q$i\nclient_address=203.0.113.9\n\n" | nc -w1 127.0.0.1 10032
done
```

Expected results (verified in build environment):

| Test | Result |
|---|---|
| 7 messages at warmup (5/min) | 5×`DUNNO`, 2×`451` |
| message with 25 recipients (cap 20) | `554 Too many recipients` |
| admin suspend → resend | `554 ...suspected abuse` |
| change tier via API | applied immediately (pub/sub) |
| wrong login / no token | `401` |

Or run the **in-process smoke test** for A (observe) + B (feedback) — calls services directly, no MTA required (needs the 2 containers above + `npm run build`):

```bash
TESTMODE=observe node test/e2e-smoke.js   # observe: flag + risk, NO suspend
TESTMODE=enforce node test/e2e-smoke.js   # enforce + bounce-rate -> suspend -> 554
```

Verified results: observe = 4 mails `DUNNO` + risk=55 (no suspend); enforce = 4 sent + 3 bounces (75% > 50%) → **suspend** → next mail `554`; wrong feedback token → `401`.

Cleanup: `docker rm -f rl-redis rl-db`.

## 7b. Common Issues

- **Admin API returns `500` at /api/tiers,/domains,/senders,/events (but login works):** DB tables not created or wrong Prisma query engine. Current release fixes this (Prisma CLI in runtime deps + `binaryTargets` matching OpenSSL 3.0). If it recurs after changing base image: **rebuild** `docker compose build --no-cache policyd && docker compose up -d`, then check `docker compose logs policyd` — should show `db push ... in sync` + `seed ... ok`, no `Query Engine ... debian-openssl`.
- **policyd restart-loop:** usually `db` not healthy yet or `DATABASE_URL` wrong — check `docker compose logs db` and the `DB_PASSWORD` variable.
- **`401` at /api/feedback/delivery:** missing or incorrect `X-Feedback-Token` header vs `FEEDBACK_TOKEN`.

## 8. Day-to-day Operations

- **Scale**: `docker compose up -d --scale policyd=6` (HAProxy + Prometheus auto-discover via DNS).
- **Check who is near quota**: UI Dashboard → "Top near quota", or `GET /api/dashboard/top?window=h1`.
- **Investigate spam**: UI Events filtered by `action=SUSPEND/OVER_QUOTA`, or query `policy_event` by `email`.
- **Clear a wrong suspend**: UI Senders → Unsuspend (removes blocklist entry + sets active).
- **Change limits at peak hours**: create `policy_schedule` (scope/ref/hour/multiplier) — data schema is already in place; multiplier applied at the resolve step (extend further for dynamic scheduling).
- **Backup**: `dbdata` volume (config + audit). Redis is ephemeral except the blocklist — AOF everysec already enabled.
