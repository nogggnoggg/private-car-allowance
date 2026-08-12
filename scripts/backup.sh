#!/usr/bin/env bash
#
# backup.sh — PHASE-011-T12 / Spec `docs/specs/PHASE-011.md`
# **AC-19**（涵蓋範圍）＋ **AC-20**（保留期）＋ **AC-21**（目的地路徑樹守門）＋
# **AC-22**（產物與日誌零明文 secrets）；§16 **D11-1**=(a)（`docker exec` ＋
# `pg_dump -Fc`）、**D11-2**=(a)（**不加密**）、**D12**=(a)（只做路徑樹守門）。
#
# 做的事（一次執行 ＝ 一次完整備份，Spec §3.2 逐字順序）：
#   目的地守門（不合格即拒絕、非零結束碼）→ ①DB 全庫 dump ②`att/` 前綴物件
#   ③`rpt/` 前綴物件 → 產生 manifest（時間戳／範圍／位元組數／雜湊／工具版本）
#   → 涵蓋完整性自檢（四來源鍵集皆在產物內）→ 保留期清理（保留最近 N 天，N ≥ 14；
#   恰 N 天保留）→ 摘要輸出（零敏感內容）。
#
# 產物（`$BACKUP_DEST_ROOT/<YYYYMMDDThhmmssZ>/`）：
#   `db.dump`（`pg_dump -Fc` 自訂格式）／`attachments.tar`／`reports.tar`／
#   `manifest.json`。中繼檔一律落在 `mktemp -d` 並於結束時刪除，不留在備份目錄內。
#
# ---------------------------------------------------------------------------
# 判準不在本檔（與 `cleanup-cli.ts` 同一條分工裁定）
# ---------------------------------------------------------------------------
# 「這個目的地可不可以寫」與「哪幾份備份可以刪」兩個判斷全部委由
# `backend/src/platform/backup-policy.ts`（純函式 ＋ 最小 CLI，有邊界格與 mutant
# 守門）。本檔只負責**執行**它的結論：bash 裡的字串前綴比對無法被 vitest 以同一組
# fixture 反覆逼問，而這兩個判斷錯了就是「備份寫進正式資料樹」或「把唯一一份備份
# 刪掉」。本檔內因此**不得**出現自算天數（`* 86400`）或自比路徑前綴的程式碼——
# 有結構斷言在 `phase11-backup-restore.test.ts` 釘死此點。
# 兩次呼叫之設定值一律經**標準輸入**（`KEY=VALUE` 逐行）交付：不走命令列（會進主機
# 行程表），也不讓對方自己讀環境（那會在 `backend/src` 新增環境讀取站點，撞 AC-11(d)
# 之封閉集合）。開發／CI 走 `tsx` ＋ 原始碼（判準與其單元測試恆為同一份），正式映像
# 無 dev 依賴故走 `dist`。
#
# ---------------------------------------------------------------------------
# 憑證（AC-22(c)）：**零命令列、零字面**
# ---------------------------------------------------------------------------
# `pg_dump`／`psql` 一律在**資料庫容器內**經 unix socket 執行，認證由容器自身的
# 設定（官方 `postgres:16` 映像之 local trust）承擔——本檔因此不需要、也從不接觸
# 任何密碼：**零 `PGPASSWORD`、零 `--password`、零連線字串字面**。`DATABASE_URL`
# 只被解析出 host／port／user／database／schema 五項（**密碼段永不取用、永不輸出**）。
# 命令列上只會出現使用者名稱與資料庫名（識別字，非憑證）。
#
# ---------------------------------------------------------------------------
# 日誌（AC-22(b)／§10 N-2）：零絕對路徑、零 storage key
# ---------------------------------------------------------------------------
# 輸出只有備份 id、各部分之位元組數、計數與**環境變數名**。目的地與 storage 的絕
# 對路徑、`att/`／`rpt/` 之完整 key 一律不印——那是七類禁字的第四、五類
# （`DATA_FLOW.md` :565③）。要對照設定值請看自己的 `.env`，不是看排程器日誌。
#
# **T12R SF-4 之修法與其代價（據實記載）**：上面這句原本只對本檔自己的 `log`／`die`
# 成立——外部工具的 stderr 會直接穿透，`tar: /tmp/…/live/att: Cannot open` 逐字把絕對
# 路徑印了出去（reviewer 實測）。現在 `pg_dump`／`psql`／`tar` 的 stderr 一律導入
# `/dev/null`，失敗改由本檔以**變數名**回報（與 AC-21(b) 同一紀律）。**代價是失敗時
# 少了外部工具的原文診斷**：這是刻意的取捨（沿 PHASE-010-T9「兜底不記例外原文，正解
# 是具名日誌」之裁定）。排障方式歸 Runbook——以相同 env 手動跑該工具一次即可看到原文。
#
# ---------------------------------------------------------------------------
# ⚠ 射程限制（**不得被誤讀**，Spec §17.1 ／ D12 逐字）
# ---------------------------------------------------------------------------
# 本檔機械保證的只有「備份不落在正式資料之**路徑樹**內」。**「不同主機／不同磁碟」
# 系統不驗證**——那是部署時之人工設定與 Runbook 檢核（AC-21(e)、AC-25(b)）。
# 同一顆磁碟上的另一個目錄會通過守門；守門放行**不等於** NFR-US-12⑤ 已滿足。
# 又：D11-2=(a) 之裁定是**不加密**，產物含個資（`User`、附件、稽核）——目的地之
# **存取權限**是唯一的保護層，Runbook 必須載明其要求。
#
# ---------------------------------------------------------------------------
# 平台前提（D11-1(a) 之已知代價）
# ---------------------------------------------------------------------------
# 需要 `docker` 可達且 DB 跑在容器內。**受管 DB（無容器可 exec）不適用**——該情
# 形之替代指令歸 Runbook（Spec §16 D11 逐字）。dev（Windows／Git Bash）、CI
# （service container）與 compose 三者皆為容器形態，故同一條路徑通用。
#
# 用法：
#   BACKUP_DEST_ROOT=… ATTACHMENT_STORAGE_ROOT=… REPORT_STORAGE_ROOT=… \
#   DATABASE_URL=… scripts/backup.sh
#
# 環境變數：
#   BACKUP_DEST_ROOT        【必要】備份目的地根目錄（AC-21(a) 守門對象）
#   ATTACHMENT_STORAGE_ROOT 【必要】附件 storage 根（受保護根 ＋ 備份來源）
#   REPORT_STORAGE_ROOT     【必要】報表 storage 根（受保護根 ＋ 備份來源）
#   DATABASE_URL            【必要】備份目標（可用 BACKUP_DATABASE_URL 覆寫）
#   BACKUP_RETENTION_DAYS   選用，預設 14；**< 14 拒絕啟動**（AC-20(c)）
#   BACKUP_PGDATA_PATH      選用；PG data 目錄之主機路徑（設了才納入守門比對）
#   BACKUP_PG_CONTAINER     選用；指定 DB 容器名（非 localhost 目標時**必要**）
#   BACKUP_ALLOW_EMPTY      選用；`1` ＝明示承認「四來源鍵集為空、涵蓋自檢無對象」
#                           而仍要備份（空庫之初始備份）。**預設拒跑**——見下方 §7
#                           之 T12R SF-1；放行時日誌與 manifest 皆帶 allow-empty 標記。
#
# 結束碼：0＝備份完成且自檢通過；非 0＝任一步失敗（**失敗時本次的半成品備份目錄
# 會被刪除**——半份備份留在目的地會被下一次的保留期清理當成一份真備份計數；
# 該清理於 EXIT／INT／TERM 三條路徑上都會執行，見 `cleanup`）。
#
# ⚠ bash 陷阱紀律（PHASE-011-T10 三犯之教訓，見 `verify-persistence.sh` 檔頭）：
#   本檔一律 `if ! cmd; then die; fi` 或 `X=$(cmd) || die`，**不寫 `cmd && die`**
#   （`set -e` 下前者失敗不觸發、後者語意相反）；不在 pipeline 尾端用 `head`
#   （`pipefail` ＋ SIGPIPE 會讓成功的命令回非零），改用 `sed -n '1p'`。

set -euo pipefail

SCRIPT_VERSION="PHASE-011-T12/1"
SCOPE_DB="postgresql-database"
SCOPE_ATT="attachment-storage"
SCOPE_RPT="report-storage"

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] ERROR: %s\n' "$1" >&2; exit "${2:-1}"; }   # 用 $1 不用 $*

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=""
TMP_WORK=""
COMPLETED=0

cleanup() {
  if [ -n "$TMP_WORK" ] && [ -d "$TMP_WORK" ]; then rm -rf "$TMP_WORK"; fi
  # 半成品備份不得留在目的地：保留期清理只看目錄名，會把它當成一份完整備份。
  if [ "$COMPLETED" -eq 0 ] && [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
    log "incomplete backup directory removed"
  fi
}
# **T12R AR-2**：只掛 EXIT 時，Ctrl-C／排程器 timeout 送來的 INT／TERM 會讓 bash 直接
# 收攤而**不跑** EXIT trap，半成品備份目錄與中繼檔就留在目的地了（檔頭 :77-78 自己點名
# 的危害）。改為把兩個訊號轉成正常的 `exit`，EXIT trap 因而必然執行、清理只有一份實作。
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------
# 0. 前置：必要 env 與外部工具
# ---------------------------------------------------------------------------

for var in BACKUP_DEST_ROOT ATTACHMENT_STORAGE_ROOT REPORT_STORAGE_ROOT; do
  if [ -z "${!var:-}" ]; then die "$var is required"; fi
done

DB_URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then die "DATABASE_URL (or BACKUP_DATABASE_URL) is required"; fi

for tool in docker tar node; do
  if ! command -v "$tool" >/dev/null 2>&1; then die "required tool not found: $tool"; fi
done

# 一律**餵 stdin** 而非給檔名：coreutils 在檔名含反斜線時會在整行前面加一個跳脫用
# 的 `\`（Windows 路徑必踩），那個 `\` 會直接寫進 manifest 的雜湊欄位變成非法 JSON。
# 走 stdin 的輸出恆為 `<hash>  -`，沒有檔名也就沒有跳脫問題。
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 < "$1" | cut -d' ' -f1
  else
    die "no sha256 tool found (need sha256sum or shasum)"
  fi
}

bytes_of() { wc -c < "$1" | tr -d ' \t\r\n'; }

# ---------------------------------------------------------------------------
# 1. 判準模組之進入點（開發／CI 走原始碼，正式映像走 dist）
# ---------------------------------------------------------------------------
# 優先 `tsx` ＋ `src`：dev 上的 `dist` 可能落後於原始碼，而「判準與其單元測試不是
# 同一份程式碼」正是本專案最不能接受的一種失真。正式映像只裝 production 依賴（無
# `tsx`），自然落到 `dist`。

POLICY_SRC="$REPO_ROOT/backend/src/platform/backup-policy.ts"
POLICY_DIST="$REPO_ROOT/backend/dist/platform/backup-policy.js"
TSX_CLI="$REPO_ROOT/node_modules/tsx/dist/cli.mjs"

if [ -f "$TSX_CLI" ] && [ -f "$POLICY_SRC" ]; then
  POLICY_CMD=(node "$TSX_CLI" "$POLICY_SRC")
elif [ -f "$POLICY_DIST" ]; then
  POLICY_CMD=(node "$POLICY_DIST")
else
  die "backup-policy entry not found (build backend or install dev dependencies first)"
fi

# ---------------------------------------------------------------------------
# 2. 目的地守門（AC-21）＋ 保留天數驗證（AC-20(c)）——兩者都在動工前 fail-fast
# ---------------------------------------------------------------------------

# 設定值走 **stdin**（`KEY=VALUE` 逐行），不走命令列也不靠 policy 自己讀環境：
# 前者會把路徑公告在主機行程表，後者會在 `backend/src` 新增一個環境讀取站點
# （AC-11(d) 之封閉集合）。空值 ＝ 未設定，由 policy 端套用預設。
policy_settings() {
  printf '%s\n' \
    "BACKUP_DEST_ROOT=$BACKUP_DEST_ROOT" \
    "ATTACHMENT_STORAGE_ROOT=$ATTACHMENT_STORAGE_ROOT" \
    "REPORT_STORAGE_ROOT=$REPORT_STORAGE_ROOT" \
    "BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-}" \
    "BACKUP_PGDATA_PATH=${BACKUP_PGDATA_PATH:-}"
}

PREFLIGHT=$(policy_settings | "${POLICY_CMD[@]}" check-destination) ||
  die "preflight rejected (see message above; nothing was written)"
log "preflight: $PREFLIGHT"

RETENTION_DAYS=$(printf '%s' "$PREFLIGHT" | sed -n 's/.*retention-days=\([0-9]*\).*/\1/p')
if [ -z "$RETENTION_DAYS" ]; then die "preflight did not report retention-days"; fi

# ---------------------------------------------------------------------------
# 3. 解析 DATABASE_URL（**密碼段永不取用**）
# ---------------------------------------------------------------------------
# 取 scheme 之後 → authority（最後一個 `@` 之前為 userinfo）→ host:port ＋ path/query。
# 已知限制：使用者名稱之 percent-encoding 不做解碼（本專案之帳號皆為單純識別字）。

DB_REST="${DB_URL#*://}"
DB_AUTHORITY="${DB_REST%%/*}"
DB_PATHQ="${DB_REST#*/}"

case "$DB_AUTHORITY" in
  *@*) DB_USERINFO="${DB_AUTHORITY%@*}"; DB_HOSTPORT="${DB_AUTHORITY##*@}" ;;
  *)   DB_USERINFO=""; DB_HOSTPORT="$DB_AUTHORITY" ;;
esac

DB_USER="${DB_USERINFO%%:*}"                      # 密碼段（`:` 之後）到此為止不再被引用
DB_HOST="${DB_HOSTPORT%%:*}"
case "$DB_HOSTPORT" in
  *:*) DB_PORT="${DB_HOSTPORT##*:}" ;;
  *)   DB_PORT="5432" ;;
esac
DB_NAME="${DB_PATHQ%%\?*}"
DB_SCHEMA=$(printf '%s' "$DB_PATHQ" | sed -n 's/.*[?&]schema=\([^&]*\).*/\1/p')
if [ -z "$DB_SCHEMA" ]; then DB_SCHEMA="public"; fi

if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then die "DATABASE_URL is missing user or database"; fi
case "$DB_SCHEMA" in
  *[!A-Za-z0-9_]*) die "unsupported schema name in DATABASE_URL" ;;
esac

# ---------------------------------------------------------------------------
# 4. 找出承載目標資料庫的容器（D11-1(a)：客戶端與伺服器同容器 → 版本必然相容）
# ---------------------------------------------------------------------------

if [ -n "${BACKUP_PG_CONTAINER:-}" ]; then
  PG_CONTAINER="$BACKUP_PG_CONTAINER"
else
  case "$DB_HOST" in
    localhost | 127.0.0.1 | ::1 | host.docker.internal) ;;
    *) die "remote database host: set BACKUP_PG_CONTAINER explicitly" ;;
  esac
  MATCHES=$(docker ps --filter "publish=$DB_PORT" --format '{{.Names}}') ||
    die "docker ps failed (is the docker daemon reachable?)"
  MATCH_COUNT=$(printf '%s' "$MATCHES" | grep -c . || true)
  if [ "$MATCH_COUNT" -ne 1 ]; then
    die "expected exactly one container publishing the database port, found $MATCH_COUNT; set BACKUP_PG_CONTAINER"
  fi
  PG_CONTAINER="$MATCHES"
fi

# 備份錯的資料庫比沒備份更糟：先確認這個容器真的服務目標庫，再動手。
if ! docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; then
  die "cannot reach the target database inside container '$PG_CONTAINER'"
fi

# ---------------------------------------------------------------------------
# 5. 建立本次備份目錄
# ---------------------------------------------------------------------------

BACKUP_ID=$(date -u +%Y%m%dT%H%M%SZ)
CREATED_AT="${BACKUP_ID:0:4}-${BACKUP_ID:4:2}-${BACKUP_ID:6:2}T${BACKUP_ID:9:2}:${BACKUP_ID:11:2}:${BACKUP_ID:13:2}Z"
WORK_DIR="$BACKUP_DEST_ROOT/$BACKUP_ID"
TMP_WORK=$(mktemp -d) || die "cannot create temporary working directory"

if [ -e "$WORK_DIR" ]; then die "backup id collision: $BACKUP_ID"; fi
mkdir -p "$WORK_DIR" || die "cannot create the backup directory (check BACKUP_DEST_ROOT)"
log "start id=$BACKUP_ID container=$PG_CONTAINER schema=$DB_SCHEMA"

# ---------------------------------------------------------------------------
# 6. ①DB 全庫（AC-19(a)）②att/（AC-19(b)）③rpt/（AC-19(c)）
# ---------------------------------------------------------------------------

if ! docker exec "$PG_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc \
  > "$WORK_DIR/db.dump" 2>/dev/null; then
  die "pg_dump failed"
fi
log "part db-dump bytes=$(bytes_of "$WORK_DIR/db.dump")"

# `-cf -` ＋ 重導向而非 `-f <檔名>`：tar 會把含 `:` 的檔名當成遠端主機（Windows
# 的 `C:/…` 必踩），走 stdout 就完全繞開那條解析。
if ! tar -C "$ATTACHMENT_STORAGE_ROOT" -cf - . > "$WORK_DIR/attachments.tar" 2>/dev/null; then
  die "tar of ATTACHMENT_STORAGE_ROOT failed"
fi
log "part attachments bytes=$(bytes_of "$WORK_DIR/attachments.tar")"

if ! tar -C "$REPORT_STORAGE_ROOT" -cf - . > "$WORK_DIR/reports.tar" 2>/dev/null; then
  die "tar of REPORT_STORAGE_ROOT failed"
fi
log "part reports bytes=$(bytes_of "$WORK_DIR/reports.tar")"

# ---------------------------------------------------------------------------
# 7. 涵蓋完整性自檢（AC-19(d)）：四來源鍵集之聯集逐鍵須在產物內
# ---------------------------------------------------------------------------
# 四來源 ＝ `Attachment.storageKey`／`Attachment.thumbnailKey`／`Report.storageKey`
# ／`VoidedReportFile.storageKey`（後者即 `KNOWN_ISSUES.md` §5-1 之作廢版物件）。
# 比對對象是**剛剛產生的 tar 內容**，不是磁碟現況——「檔案還在」與「檔案進了備份」
# 是兩件事，這裡要證的是後者。

COVERAGE_SQL="SELECT \"storageKey\" FROM \"$DB_SCHEMA\".\"Attachment\"
UNION ALL SELECT \"thumbnailKey\" FROM \"$DB_SCHEMA\".\"Attachment\" WHERE \"thumbnailKey\" IS NOT NULL
UNION ALL SELECT \"storageKey\" FROM \"$DB_SCHEMA\".\"Report\"
UNION ALL SELECT \"storageKey\" FROM \"$DB_SCHEMA\".\"VoidedReportFile\""

if ! docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$COVERAGE_SQL" \
  > "$TMP_WORK/keys.txt" 2>/dev/null; then
  die "coverage query failed"
fi

# **T12R SF-2**：原本兩個 `tar -tf` 包在 `{ …; …; } | sed > f || die` 裡——那是
# **群組**的語意：第一個 tar 失敗時，群組的結束碼取自最後一個命令，`|| die` 不觸發、
# `set -e` 不觸發、`pipefail` 也只看 pipeline 最後一段，於是「只列到一半的條目清單」
# 會被當成完整清單拿去比對，**缺席的鍵反而全數判定為在場**。逐個列、逐個守門。
: > "$TMP_WORK/entries.txt"
for archive in attachments reports; do
  if ! tar -tf - < "$WORK_DIR/$archive.tar" 2>/dev/null \
    | sed -e 's#^\./##' -e '/\/$/d' >> "$TMP_WORK/entries.txt"; then
    die "cannot list archive entries: $archive"
  fi
done

KEYS_TOTAL=0
KEYS_MISSING=0
while IFS= read -r key; do
  key="${key%$'\r'}"
  if [ -z "$key" ]; then continue; fi
  KEYS_TOTAL=$((KEYS_TOTAL + 1))
  if ! grep -Fxq -- "$key" "$TMP_WORK/entries.txt"; then
    KEYS_MISSING=$((KEYS_MISSING + 1))
  fi
done < "$TMP_WORK/keys.txt"

KEYS_PRESENT=$((KEYS_TOTAL - KEYS_MISSING))
ALLOW_EMPTY_APPLIED=false

# **T12R SF-1（fail-closed）**：四來源鍵集為空時，`missing=0` 會讓自檢**恆真**——
# 日誌形狀與真正驗證過的那一次一模一樣（reviewer 以 `?schema=` 指向空 schema 實測：
# keys=0／missing=0／exit 0，還產出兩份空 tar）。「沒有東西可驗」不得與「驗過了都在」
# 同結局，故預設**拒跑**；確為空庫初始備份時，由維運人員以 `BACKUP_ALLOW_EMPTY=1`
# **明示承認**，且該次備份於日誌與 manifest 皆帶 `allow-empty` 標記使產物可辨識。
if [ "$KEYS_TOTAL" -eq 0 ]; then
  if [ "${BACKUP_ALLOW_EMPTY:-}" = "1" ]; then
    ALLOW_EMPTY_APPLIED=true
    log "coverage: sources=4 keys=0 present=0 missing=0 allow-empty=yes (unverifiable coverage, explicitly acknowledged)"
  else
    log "coverage: sources=4 keys=0 present=0 missing=0"
    die "coverage self-check has nothing to verify: the four key sources are empty. Check the DATABASE_URL schema and the storage roots; if this really is an initial backup of an empty database, acknowledge it explicitly with BACKUP_ALLOW_EMPTY=1"
  fi
else
  log "coverage: sources=4 keys=$KEYS_TOTAL present=$KEYS_PRESENT missing=$KEYS_MISSING"
fi

if [ "$KEYS_MISSING" -ne 0 ]; then
  # 刻意不印是哪一個 key（AC-22(b) 之 storageKey 禁字）——查法見 Runbook。
  die "coverage self-check failed: missing=$KEYS_MISSING of $KEYS_TOTAL (AC-19(d))"
fi

# ---------------------------------------------------------------------------
# 8. manifest（AC-19(e) 六欄：時間戳／涵蓋範圍／各部分／位元組數／雜湊／工具版本）
# ---------------------------------------------------------------------------

PG_DUMP_VERSION=$(docker exec "$PG_CONTAINER" pg_dump --version 2>/dev/null | awk '{print $3}' | tr -d '"\\')
TAR_VERSION=$(tar --version 2>/dev/null | sed -n '1p' | tr -d '"\\')

manifest_part() {   # $1=name $2=scope $3=file
  printf '    { "name": "%s", "scope": "%s", "file": "%s", "bytes": %s, "sha256": "%s" }' \
    "$1" "$2" "$3" "$(bytes_of "$WORK_DIR/$3")" "$(sha256_of "$WORK_DIR/$3")"
}

{
  printf '{\n'
  printf '  "backupId": "%s",\n' "$BACKUP_ID"
  printf '  "createdAt": "%s",\n' "$CREATED_AT"
  printf '  "scope": ["%s", "%s", "%s"],\n' "$SCOPE_DB" "$SCOPE_ATT" "$SCOPE_RPT"
  printf '  "parts": [\n'
  manifest_part "db-dump" "$SCOPE_DB" "db.dump"; printf ',\n'
  manifest_part "attachments" "$SCOPE_ATT" "attachments.tar"; printf ',\n'
  manifest_part "reports" "$SCOPE_RPT" "reports.tar"; printf '\n'
  printf '  ],\n'
  printf '  "tools": { "pg_dump": "%s", "tar": "%s", "script": "%s" },\n' \
    "$PG_DUMP_VERSION" "$TAR_VERSION" "$SCRIPT_VERSION"
  # `allowEmpty`＝這份備份的涵蓋自檢**無可驗證之對象**（四來源鍵集為空），由維運人員
  # 明示承認而放行（T12R SF-1）。寫進 manifest 使產物自身可辨識——否則一份「沒驗過」
  # 的備份與一份「驗過都在」的備份在檔案層完全長得一樣。
  printf '  "coverage": { "keys": %s, "present": %s, "missing": %s, "allowEmpty": %s },\n' \
    "$KEYS_TOTAL" "$KEYS_PRESENT" "$KEYS_MISSING" "$ALLOW_EMPTY_APPLIED"
  printf '  "retentionDays": %s\n' "$RETENTION_DAYS"
  printf '}\n'
} > "$WORK_DIR/manifest.json" || die "cannot write manifest"

# 本次備份至此完整——之後任何失敗都不該把它刪掉（它已是一份可用的備份）。
COMPLETED=1

# ---------------------------------------------------------------------------
# 9. 保留期清理（AC-20）：刪誰由 backup-policy 決定，本檔只執行
# ---------------------------------------------------------------------------

REMOVE_LIST=$(policy_settings | "${POLICY_CMD[@]}" plan-retention) || die "retention planning failed"

# **T12R AR-1：先全部驗完，通過才開始刪。**
# 原本是邊驗邊刪：清單第 3 筆撞上防呆而中止時，第 1、2 筆**已經刪掉了**——一個不可逆
# 刪除工具不該把「守門攔截」變成「刪了一半」。§11.0 #3 的紀律要求兩階段：
#   階段一（唯讀）三重防呆逐筆驗證，任一筆不合格即中止，**此時零刪除**；
#   階段二 才動 `rm`。
VALIDATED_IDS=()
while IFS= read -r id; do
  id="${id%$'\r'}"
  if [ -z "$id" ]; then continue; fi
  # 三重防呆（不可逆刪除）：形狀、不是本次剛做好的那份、確實是個目錄。
  case "$id" in
    *[!0-9A-Za-z]*) die "refusing to remove an unexpected directory name (nothing has been removed)" ;;
  esac
  if [ "$id" = "$BACKUP_ID" ]; then
    die "retention plan targeted the backup just created (nothing has been removed)"
  fi
  if [ -d "$BACKUP_DEST_ROOT/$id" ]; then VALIDATED_IDS+=("$id"); fi
done <<< "$REMOVE_LIST"

REMOVED=0
for id in ${VALIDATED_IDS[@]+"${VALIDATED_IDS[@]}"}; do
  rm -rf "${BACKUP_DEST_ROOT:?}/$id"
  REMOVED=$((REMOVED + 1))
done

log "retention: days=$RETENTION_DAYS removed=$REMOVED"
log "done id=$BACKUP_ID parts=3"
