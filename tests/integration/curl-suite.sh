#!/usr/bin/env bash
# Run after starting the daemon. Exits non-zero on any failure.
set -euo pipefail

PORT="${CLAUDECLAW_PORT:-4632}"
TOKEN="$(cat .claude/claudeclaw/web.token)"
BASE="http://127.0.0.1:${PORT}"

assert_eq() {
  if [ "$1" != "$2" ]; then
    echo "FAIL: expected '$2', got '$1'"; exit 1
  fi
}
echo_test() { printf "  %-60s " "$1"; }

echo "Auth tests"
echo_test "no token → 401"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/state")
assert_eq "$code" "401"; echo "OK"

echo_test "wrong token → 401"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong" "$BASE/api/state")
assert_eq "$code" "401"; echo "OK"

echo_test "correct token → 200"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE/api/state")
assert_eq "$code" "200"; echo "OK"

echo_test "query-param token works"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/state?token=$TOKEN")
assert_eq "$code" "200"; echo "OK"

echo "Host header tests"
echo_test "bad Host → 421"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" -H "Host: evil.com" "$BASE/api/state")
assert_eq "$code" "421"; echo "OK"

echo "Origin tests"
echo_test "POST with cross-origin Origin → 403"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: https://evil.com" \
  -H "Content-Type: application/json" \
  -d '{"time":"00:00","prompt":"x"}' \
  "$BASE/api/jobs/quick")
assert_eq "$code" "403"; echo "OK"

echo_test "POST with no Origin → 200 (curl-style access)"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"time":"00:00","prompt":"x"}' \
  "$BASE/api/jobs/quick")
assert_eq "$code" "200"; echo "OK"

echo "Secrets-leak tests"
echo_test "/api/technical-info does not return Telegram token"
body=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/technical-info")
# Look for any 35-50 char string starting with digits and a colon (Telegram token format).
if echo "$body" | grep -E '"[0-9]{8,12}:[A-Za-z0-9_-]{30,40}"' >/dev/null; then
  echo "FAIL: technical-info appears to contain a Telegram token"; exit 1
fi
echo "OK"

echo "All integration tests passed."
