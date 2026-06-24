/**
 * Lua scripts run atomically on Redis. Embedding them as strings (instead of
 * shipping .lua asset files) keeps Docker builds path-independent.
 */

/**
 * Multi-window fixed-counter check-and-increment.
 *
 * KEYS = counter keys (one per window/scope being enforced)
 * ARGV = [inc, limit_1, ttl_1, limit_2, ttl_2, ...]   (one (limit,ttl) pair per KEY)
 *
 * Semantics: check ALL windows first; if adding `inc` would exceed any limit,
 * reject WITHOUT incrementing (the rejected mail is not counted). Otherwise
 * increment every counter and set its TTL on first creation.
 *
 * Returns: {1, 0, 0, 0}                  -> allowed
 *          {0, i, current, limit}         -> rejected by the i-th window (1-based)
 */
export const RL_CHECK = `
local inc = tonumber(ARGV[1])
for i = 1, #KEYS do
  local limit = tonumber(ARGV[2*i])
  local cur = tonumber(redis.call('GET', KEYS[i]) or '0')
  if cur + inc > limit then
    return {0, i, cur, limit}
  end
end
for i = 1, #KEYS do
  local ttl = tonumber(ARGV[2*i+1])
  local new = redis.call('INCRBY', KEYS[i], inc)
  if new == inc then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end
return {1, 'OK'}
`;

/**
 * GCRA (generic cell rate algorithm) token-bucket throttle - OPTIONAL, smoother
 * than fixed windows (no boundary burst). Mirrors redis-cell CL.THROTTLE without
 * requiring the module. Not used on the default path; available for "send rate"
 * smoothing if you enable it.
 *
 * KEYS[1] = bucket key
 * ARGV = [now_ms, burst, count_per_period, period_ms, quantity]
 * Returns: {allowed(1/0), remaining, retry_after_ms}
 */
export const GCRA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local count = tonumber(ARGV[3])
local period = tonumber(ARGV[4])
local qty = tonumber(ARGV[5])
local emission = period / count
local tolerance = emission * burst
local tat = tonumber(redis.call('GET', key) or now)
if tat < now then tat = now end
local new_tat = tat + emission * qty
local allow_at = new_tat - tolerance
if now < allow_at then
  return {0, 0, math.ceil(allow_at - now)}
end
redis.call('SET', key, new_tat, 'PX', math.ceil(new_tat - now + tolerance))
local remaining = math.floor((now - (new_tat - tolerance)) / emission)
return {1, remaining, 0}
`;

/**
 * Increment a counter and set TTL only when freshly created. Returns new value.
 * KEYS[1] = key, ARGV = [inc, ttl]
 */
export const INCR_TTL = `
local new = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if new == tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return new
`;
