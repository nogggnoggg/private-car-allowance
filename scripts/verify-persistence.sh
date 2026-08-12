#!/usr/bin/env bash
#
# verify-persistence.sh — PHASE-011-T10 / Spec `docs/specs/PHASE-011.md`
# AC-15（容器重建不失資料）＋ AC-16(a)(b)（三面分離部署）之**可重複執行驗證程序**。
#
# 做的事（一次執行 ＝ 一次完整驗證）：起 stack 並等三面就緒（AC-16(a)：前端 :8080 → nginx
# `/api` → 後端 → DB）→ 純 API 播種一筆**含附件之已完成差旅申請**並產生正式 PDF（全合成
# 資料）→ 記錄三指紋（①DB：申請 id ＋ totalAmount ②附件位元組 sha256 ③PDF 位元組 sha256）
# → 依 `--mode` 對 stack 施作一次生命週期操作 → 重新取三指紋**逐一比對**；任一不等即印出
# 差異並以**非零結束碼**結束。
#
# 模式（AC 對應）：
#   preserve         `docker compose down`（**不加 -v**）→ `up -d`         → 期望三指紋全等（AC-15(a)(b)(c)）
#   destroy          `docker compose down -v`（**刪 volume**）→ `up -d`     → **期望失敗**（AC-15(d) 反向對照／鑑別力）
#   rebuild-backend  只重建後端 → 期望 db／frontend 之容器 id 與映像 id 不變、資料不變（AC-16(b)②）
#   rebuild-frontend 只重建前端 → 期望 db／backend 之容器 id 與映像 id 不變、資料不變（AC-16(b)①）
#
# 結束碼：0＝三指紋全等且模式斷言成立；1＝任一不等或斷言不成立；2＝前置條件不足（環境／參
# 數／目標非本機），**或前側三指紋未能全數取得＝本次比對無鑑別力**（見步驟 3 之守門）。
# `destroy` 模式**必然**回 1——那正是「本驗證不是恆真」的證據，不是缺陷。
#
# ⛔ **僅限 dev／staging，禁止對正式環境執行**：本程序不是唯讀探針——它會建立全域參數版
#   本、建立並完成一筆申請、**消耗一個正式報表編號（不可回收）**，`destroy` 模式更會刪
#   volume。非本機 BASE_URL 一律拒跑（結束碼 2），除非明示 `--yes-write-to-remote`。
#
# 用法：
#   scripts/verify-persistence.sh [--mode preserve|destroy|rebuild-backend|rebuild-frontend]
#                                 [--yes-destroy-data] [--yes-write-to-remote]
#
# 必要環境變數（**憑證一律經環境變數，絕不經命令列**；本檔零憑證字面）：
#   VERIFY_ADMIN_LOGIN／VERIFY_ADMIN_PASSWORD  管理員帳號與目前密碼
#   VERIFY_ADMIN_INITIAL_PASSWORD  僅在 DB 無任何 ADMIN 時使用（自舉：seed → 強制改密為
#     VERIFY_ADMIN_PASSWORD；兩者必須不同）。選用：BASE_URL（預設 http://localhost:8080）、
#     COMPOSE_PROJECT_NAME（預設 oilexpense）、WAIT_TIMEOUT_SEC（預設 300）。
#
# ⚠ Windows 環境紀律（PHASE-009 事故教訓，違反即重演）：本倉庫實際路徑含中文，BuildKit 對含
#   非 ASCII 之 build context 會失敗。`rebuild-*` 兩模式會呼叫 `docker compose build`，故
#   **必須經 junction 執行**（本腳本會在 build 前自檢路徑，違反即拒跑、結束碼 2）：
#     powershell -Command "cd C:\oilexp-build; bash scripts/verify-persistence.sh --mode rebuild-backend"
#   preserve／destroy 不受此限（專案名以 COMPOSE_PROJECT_NAME 指定，不依賴目錄名——中文目
#   錄名會讓 compose 推導出空專案名）。
#
# 安全紀律：只操作 COMPOSE_PROJECT_NAME 指定之專案；`destroy` 需 `--yes-destroy-data` 明示；
# 非本機 BASE_URL 需 `--yes-write-to-remote` 明示（見上方紅字）。
# 測試庫容器 `t1-pg`（:55432）不屬本專案，本腳本永不觸及。輸出零密碼、零 session token。

set -euo pipefail

MODE=preserve; CONFIRM_DESTROY=0; CONFIRM_REMOTE=0
BASE_URL="${BASE_URL:-http://localhost:8080}"
WAIT_TIMEOUT_SEC="${WAIT_TIMEOUT_SEC:-300}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-oilexpense}"
SERVICES="db backend frontend"; FUEL_TYPE=GASOLINE_92; PARAM_FROM=2020-06-01

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$1" >&2; exit "${2:-2}"; }   # 用 $1 不用 $*：否則結束碼參數會被印進訊息

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --yes-destroy-data) CONFIRM_DESTROY=1; shift ;;
    --yes-write-to-remote) CONFIRM_REMOTE=1; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) die "未知參數：$1" ;;
  esac
done

case "$MODE" in
  preserve|destroy|rebuild-backend|rebuild-frontend) ;;
  *) die "未知模式：$MODE" ;;
esac
if [ "$MODE" = destroy ] && [ "$CONFIRM_DESTROY" -ne 1 ]; then
  die "destroy 模式會刪除 $COMPOSE_PROJECT_NAME 的 volume（資料全失），須加 --yes-destroy-data 明示"
fi
# ⛔ 寫入面守門（T10R SF-1）：本程序**會寫入業務資料**——建立全域參數版本、建立並完成一筆
# 申請、**消耗一個正式報表編號**（編號不可回收）。而「確認重啟不失資料」恰恰是維運最容易
# 直接對正式環境跑的程序，故非本機目標一律拒跑，需明示旗標才放行。
if [ "$CONFIRM_REMOTE" -ne 1 ]; then
  case "$BASE_URL" in
    *localhost*|*127.0.0.1*) ;;
    *) die "非本機目標須以 --yes-write-to-remote 明示（本程序會寫入業務資料與消耗報表編號）" 2 ;;
  esac
fi
for tool in docker curl sha256sum base64 diff; do
  command -v "$tool" >/dev/null 2>&1 || die "缺少必要工具：$tool"
done
: "${VERIFY_ADMIN_LOGIN:?請以環境變數提供（勿寫在命令列參數）}"
: "${VERIFY_ADMIN_PASSWORD:?請以環境變數提供（勿寫在命令列參數）}"

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"
if [ "${MODE#rebuild-}" != "$MODE" ] && printf '%s' "$REPO_ROOT" | LC_ALL=C grep -q '[^ -~]'; then
  die "build 路徑含非 ASCII 字元（$REPO_ROOT）：BuildKit 會失敗。請改由 junction 執行（見檔頭）"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/jar"; RESP="$TMP/resp.json"
API="$BASE_URL/api"

dc() { docker compose "$@"; }
api() { # method path  (body 由 stdin 給；回應寫入 $RESP；印出 HTTP 狀態碼)
  curl -sS -b "$JAR" -c "$JAR" -X "$1" -H 'Content-Type: application/json' \
    --data-binary @- -o "$RESP" -w '%{http_code}' "$API$2" || printf '000'
}
api_get() { curl -sS -b "$JAR" -c "$JAR" -o "${2:-$RESP}" -w '%{http_code}' "$API$1" || printf '000'; }
jstr() { grep -oE "\"$2\":\"[^\"]*\"" "$1" | head -1 | sed 's/^[^:]*:"//; s/"$//'; }
jnum() { grep -oE "\"$2\":-?[0-9]+" "$1" | head -1 | sed 's/^[^:]*://'; }

snapshot_ids() { # 每服務一行：service container=<id> image=<id>（AC-16(b) 之機械證據）
  local s cid
  for s in $SERVICES; do
    cid=$(dc ps -q "$s" 2>/dev/null | tr -d '\r' | head -1 || true)
    if [ -z "$cid" ]; then printf '%-9s container=<none> image=<none>\n' "$s"; else
      printf '%-9s container=%s image=%s\n' "$s" "${cid:0:12}" \
        "$(docker inspect -f '{{.Image}}' "$cid" | cut -c1-19)"
    fi
  done
}

wait_ready() { # 三面就緒：db/backend 之 compose health ＋ 經 nginx 的 /api/health 回 200
  local deadline=$(( $(date +%s) + WAIT_TIMEOUT_SEC )) code
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # 用 `|| true` 而非 `|| echo 000`：連線失敗時 curl 自己已經寫出 `-w` 的 000，再補一次
    # 會讓逾時訊息顯示成 `000000`（T10R 實測發現）。
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$API/health" 2>/dev/null || true)
    if [ "$code" = 200 ]; then
      log "就緒：GET /api/health → 200（前端 :8080 → 後端 → DB 全鏈通）"
      dc ps --format '  {{.Service}} {{.Name}} {{.State}} {{.Health}}'
      return 0
    fi
    sleep 3
  done
  die "等待逾時（${WAIT_TIMEOUT_SEC}s）：/api/health 未回 200（最後 ${code:-000}）" 1
}

login() { # 0＝已登入且可操作；非 0＝登入失敗（destroy 後之空 DB 即為此路徑）
  local code
  code=$(printf '{"loginName":"%s","password":"%s"}' "$VERIFY_ADMIN_LOGIN" "$1" | api POST /auth/login)
  [ "$code" = 200 ]
}

bootstrap_admin() { # 空 DB 自舉：seed-admin（憑證經 stdin 餵入容器內 sh，不進 argv）→ 強制改密
  log "登入失敗 → 嘗試自舉管理員（僅在 DB 無任何 ADMIN 時會實際建立）"
  : "${VERIFY_ADMIN_INITIAL_PASSWORD:?空 DB 自舉需要此環境變數（且須與 VERIFY_ADMIN_PASSWORD 不同）}"
  local sq_login sq_pw code
  sq_login=$(printf "%s" "$VERIFY_ADMIN_LOGIN" | sed "s/'/'\\\\''/g")
  sq_pw=$(printf "%s" "$VERIFY_ADMIN_INITIAL_PASSWORD" | sed "s/'/'\\\\''/g")
  printf "SEED_ADMIN_LOGIN='%s' SEED_ADMIN_PASSWORD='%s' node dist/seed/seed-admin.js\n" \
    "$sq_login" "$sq_pw" | dc exec -T backend sh
  login "$VERIFY_ADMIN_INITIAL_PASSWORD" || die "以初始密碼登入仍失敗（帳號或密碼與現況不符）" 1
  code=$(printf '{"currentPassword":"%s","newPassword":"%s"}' \
    "$VERIFY_ADMIN_INITIAL_PASSWORD" "$VERIFY_ADMIN_PASSWORD" | api POST /me/password)
  [ "$code" = 200 ] || die "強制改密失敗（HTTP $code）" 1
  login "$VERIFY_ADMIN_PASSWORD" || die "改密後登入失敗" 1
}

ensure_param() { # 路徑 覆蓋日 建立用 JSON：先查後建（沿 e2e 既有慣例，避免重複版本）
  local path="$1" want="$2" body="$3" v code
  code=$(api_get "$path"); [ "$code" = 200 ] || die "讀取參數失敗：$path（HTTP $code）" 1
  for v in $(grep -oE '"effectiveFrom":"[0-9]{4}-[0-9]{2}-[0-9]{2}"' "$RESP" | cut -d'"' -f4); do
    if [[ "$v" < "$want" || "$v" == "$want" ]]; then return 0; fi
  done
  code=$(printf '%s' "$body" | api POST "${path%%\?*}")
  [ "$code" = 201 ] || die "建立參數失敗：$path（HTTP $code）$(head -c 200 "$RESP")" 1
}

seed_fixture() { # 播種一筆含附件之已完成差旅申請 ＋ 產生正式 PDF（全合成、全 ASCII）
  local uid trip code
  code=$(api_get /me); [ "$code" = 200 ] || die "GET /me 失敗（HTTP $code）" 1
  uid=$(jstr "$RESP" id); trip=$(date -u +%F)
  ensure_param "/parameters/fuel-price?fuelType=$FUEL_TYPE" "$trip" \
    "{\"fuelType\":\"$FUEL_TYPE\",\"pricePerLiter\":\"65.0000\",\"effectiveFrom\":\"$PARAM_FROM\"}"
  ensure_param "/parameters/etc" "$trip" \
    "{\"unitPrice\":1.8,\"effectiveFrom\":\"$PARAM_FROM\"}"
  ensure_param "/users/$uid/fuel-consumption" "$trip" \
    "{\"fuelType\":\"$FUEL_TYPE\",\"kmPerLiter\":\"10.0000\",\"effectiveFrom\":\"$PARAM_FROM\",\"basisNote\":\"PHASE-011-T10 synthetic fixture\"}"
  base64 -d >"$TMP/shot.png" <<'PNG_B64'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
PNG_B64
  # `-F file=@<路徑>` 內的路徑不會被 MSYS 自動轉成 Windows 形式（值含 @ 與 ;，不符轉換啟發
  # 式），原生 curl.exe 會讀不到 `/tmp/...` 而回 curl(26)。故 cd 進暫存目錄用相對檔名——
  # 此寫法在 Linux／macOS 同樣正確（同族教訓：PHASE-009 BuildKit 中文路徑、PHASE-010 curl UTF8）。
  code=$(cd "$TMP" && curl -sS -b "$JAR" -c "$JAR" -o "$RESP" -w '%{http_code}' \
    -F "file=@shot.png;type=image/png" "$API/attachments" || printf '000')
  [ "$code" = 201 ] || die "上傳附件失敗（HTTP $code）" 1
  ATT_ID=$(jstr "$RESP" id)
  code=$(printf '{}' | api POST /applications/travel)
  [ "$code" = 201 ] || die "建立差旅草稿失敗（HTTP $code）" 1
  APP_ID=$(jstr "$RESP" id)
  code=$(printf '{"tripDate":"%s","purpose":"PHASE-011-T10 persistence fixture","segments":[{"origin":"SiteA","destination":"SiteB","totalKm":"50.00","highwayKm":"10.00","attachmentIds":["%s"]}]}' \
    "$trip" "$ATT_ID" | api PUT "/applications/travel/$APP_ID")
  [ "$code" = 200 ] || die "填寫差旅草稿失敗（HTTP $code）$(head -c 200 "$RESP")" 1
  code=$(printf '{}' | api POST "/applications/$APP_ID/complete")
  [ "$code" = 200 ] || die "完成申請失敗（HTTP $code）$(head -c 300 "$RESP")" 1
  code=$(printf '{}' | api POST "/applications/$APP_ID/report")
  [ "$code" = 201 ] || die "產生正式報表失敗（HTTP $code）$(head -c 300 "$RESP")" 1
  log "已播種：申請 $APP_ID／附件 $ATT_ID／報表 $(jstr "$RESP" reportNumber)"
}

fp_bytes() { # 標籤 端點 落地檔：位元組指紋（AC-15(b)(c)——經授權端點取回後逐位元組比對）
  local code; code=$(api_get "$2" "$3")
  if [ "$code" = 200 ]; then
    printf '%s sha256=%s bytes=%s\n' "$1" \
      "$(sha256sum <"$3" | cut -d' ' -f1)" "$(wc -c <"$3" | tr -d ' ')"
  else printf '%s UNAVAILABLE(HTTP %s)\n' "$1" "$code"; fi
}

fingerprints() { # 三指紋逐行輸出；任一取不到即輸出 UNAVAILABLE(<code>)（比對時自然不等）
  local code; code=$(api_get "/applications/travel/$APP_ID")
  if [ "$code" = 200 ]; then
    printf 'FP1 db         id=%s totalAmount=%s\n' "$(jstr "$RESP" id)" "$(jnum "$RESP" totalAmount)"
  else printf 'FP1 db         UNAVAILABLE(HTTP %s)\n' "$code"; fi
  fp_bytes 'FP2 attachment' "/attachments/$ATT_ID/content" "$TMP/att.bin"
  fp_bytes 'FP3 pdf       ' "/applications/$APP_ID/report/pdf" "$TMP/rep.pdf"
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
log "模式=$MODE  專案=$COMPOSE_PROJECT_NAME  倉庫=$REPO_ROOT"
log "步驟 1／6：起 stack"
dc up -d --no-build   # --no-build：映像缺席時大聲失敗，而不是從（可能含中文的）當前路徑偷偷 build
wait_ready

log "步驟 2／6：登入並播種（含附件之已完成申請 ＋ 正式 PDF）"
login "$VERIFY_ADMIN_PASSWORD" || bootstrap_admin
seed_fixture

log "步驟 3／6：記錄三指紋（前）"
fingerprints | tee "$TMP/before.txt"
# 恆真走廊守門（T10R MF-1）：**前側**三指紋必須全數真的取得，且 FP1 必須真的解析出值。
# 否則「前後全等」會退化成「兩側同樣取不到／同樣是空字串」——diff 相等、印✅、exit 0，
# 整道驗證自我遮蔽。可達性不是理論：三個讀取端點任一回 403/404/500（權限鏈斷正是
# AC-15(b) 的被測對象），或 DTO 欄位改名使 `jstr`/`jnum` 靜默產生空字串，都會走進來。
# **只守前側**：後側 UNAVAILABLE 是「資料真的沒了」的正確訊號，必須維持紅燈（AC-15(d)）。
# 一律用 if 形式——`A && die` 在 set -e 下遇 grep 不中會靜默 exit 1，本檔已犯過三次同型。
if grep -q 'UNAVAILABLE' "$TMP/before.txt"; then die "前側三指紋未能全數取得：本次比對無鑑別力（見上）" 2; fi
if ! grep -qE '^FP1 db +id=[A-Za-z0-9]+ totalAmount=-?[0-9]+$' "$TMP/before.txt"; then die "FP1 解析失敗（欄位名可能已變更）" 2; fi
snapshot_ids >"$TMP/ids-before.txt"; sed 's/^/  /' "$TMP/ids-before.txt"

log "步驟 4／6：對 stack 施作（$MODE）"
case "$MODE" in
  preserve) dc down; dc up -d --no-build ;;
  destroy)
    log "⚠ 刪除 volume（$COMPOSE_PROJECT_NAME 專案；反向對照，期望本次驗證失敗）"
    dc down -v; dc up -d --no-build ;;
  rebuild-backend)  dc build backend;  dc up -d --no-deps --force-recreate backend ;;
  rebuild-frontend) dc build frontend; dc up -d --no-deps --force-recreate frontend ;;
esac
wait_ready

log "步驟 5／6：重新登入並記錄三指紋（後）"
login "$VERIFY_ADMIN_PASSWORD" || log "（登入失敗——DB 已無此帳號，三指紋將全數 UNAVAILABLE）"
fingerprints | tee "$TMP/after.txt"
snapshot_ids >"$TMP/ids-after.txt"; sed 's/^/  /' "$TMP/ids-after.txt"

log "步驟 6／6：比對"
STATUS=0
if diff -u "$TMP/before.txt" "$TMP/after.txt" >"$TMP/fp.diff"; then
  echo "  ✅ 三指紋逐一全等（DB／附件位元組／PDF 位元組）"
else
  echo "  ❌ 三指紋不全等："; sed 's/^/    /' "$TMP/fp.diff"; STATUS=1
fi

case "$MODE" in
  rebuild-*)
    target=${MODE#rebuild-}
    for s in $SERVICES; do
      b=$(grep "^$s " "$TMP/ids-before.txt" || echo '<missing>')
      a=$(grep "^$s " "$TMP/ids-after.txt" || echo '<missing>')
      if [ "$s" = "$target" ]; then
        if [ "$b" = "$a" ]; then echo "  ❌ $s 應被重建但容器未更換：$a"; STATUS=1
        else echo "  ✅ $s 已重建：$b → $a"; fi
      elif [ "$b" = "$a" ]; then echo "  ✅ $s 未受影響（容器 id 與映像 id 皆不變）：$a"
      else echo "  ❌ $s 不應變動卻變了：$b → $a"; STATUS=1; fi
    done ;;
  destroy)
    if [ "$STATUS" -eq 0 ]; then
      echo "  ❌ 反向對照失效：刪 volume 後三指紋竟仍全等 → 本驗證程序恆真，不可採信"; STATUS=1
    else
      echo "  ✅ 反向對照成立：刪 volume 後驗證確實失敗（本程序具鑑別力）；結束碼 1 為預期結果"
    fi ;;
esac

log "結束碼 $STATUS"
exit "$STATUS"
