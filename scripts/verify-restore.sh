#!/usr/bin/env bash
#
# verify-restore.sh — PHASE-011-T13 / Spec `docs/specs/PHASE-011.md`
# **AC-23**（還原驗證之三項確認）＋ **AC-24**（驗證紀錄）；§16 **D13**=(a)+(b)
# 併用；§5 **B-19**（還原目標三元組）／**B-20**（損毀備份必然失敗）／**B-21**
# （抽樣時 storage 鍵缺失）。
#
# 做的事（一次執行 ＝ 一次每月還原演練，Spec §3.3 逐字順序）：
#   前置守門（B-19 三元組 ＋ 目標庫不得已存在）→ 取最近一份備份 →
#   還原至【隔離目標】→ ①DB 可開啟 ＋ `_prisma_migrations` 尾筆相符
#   → ②附件抽樣 ≥3（含 thumb、含修正版副本）＋ 部件雜湊對 manifest 全等
#   → ③關聯完整性（動態全外鍵 ＋ 七項固定清單）→ 全通過 → 成功紀錄；
#   任一失敗 → 失敗紀錄（階段 ＋ 摘要）＋ 非零結束碼 → 隔離目標一律刪除。
#
# 產物：`$RESTORE_VERIFY_LOG` **追加**一行 JSON（AC-24(b)；成功亦留一行，AC-24(c)）。
# 隔離還原目標為本腳本自建之獨立資料庫，**用畢即刪**；正式面全程唯讀。
#
# ---------------------------------------------------------------------------
# 判準不在本檔（沿 `backup.sh` 與 `cleanup-cli.ts` 之同一條分工裁定）
# ---------------------------------------------------------------------------
# 「這個目標可不可以還原上去」「這批關聯算不算有孤兒」「這組抽樣夠不夠」「這筆
# 紀錄長什麼樣」四個判斷全部委由 `backend/src/platform/restore-check.ts`（純函式
# ＋ 最小 CLI，有邊界格與 mutant 守門）。本檔只負責**執行**它的結論。
# 設定值一律經**標準輸入**交付（`KEY=VALUE` 逐行；需要餵資料者再接一行
# `--payload--` 與原始資料）：不走命令列——本檔手上有**兩條**連線字串，走 argv
# 等於把密碼公告在主機行程表（AC-22(c)）。
#
# ---------------------------------------------------------------------------
# 不可逆動作之前置（§11.0 #3／T12 硬規則②：先全驗後執行）
# ---------------------------------------------------------------------------
# 本檔會 `CREATE DATABASE` 與 `DROP DATABASE`。**四道**前置，全部在建立之前完成：
#   ①**B-19 三元組守門**（host＋db＋schema 與正式相同 → 拒跑；判準在 TS）；
#   ②**三個識別字之形狀檢查**——目標庫名、目標 schema、**要驗的 schema**
#     （`RESTORE_VERIFY_SCHEMA`，預設取來源之 `schema=`）須為單純小寫識別字。
#     **T13R SF-1**：這一道原本落在 `sql-*` 子命令裡，而那些跑在建庫與整份
#     `pg_restore` **之後**——即審以 `RESTORE_VERIFY_SCHEMA='Bad-Schema'` 實測，
#     庫建好了、還原也跑完了才拒，且紀錄之階段歸屬失真。形狀檢查零 I/O，
#     沒有任何理由排在不可逆動作後面，現已全部併入 `check-target`；
#   ③**目標庫不得已存在**——已存在即拒跑，**絕不覆寫**任何既有資料庫；
#   ④`DROP` 只對「本次執行親手建立的那一個名字」發出（`CREATED_DB` 為空即不刪），
#     且刪除前再比對一次它不等於來源庫名。守門攔截時零刪除。
#
# ---------------------------------------------------------------------------
# 日誌（AC-22(b)／AC-24(d)／§10 N-2）：零絕對路徑、零 storage key、零連線字串
# ---------------------------------------------------------------------------
# 輸出只有備份 id、階段代碼、計數與**環境變數名**。抽樣到的 storage key 只在
# 記憶體裡流動，從不進日誌也不進紀錄檔（那是七類禁字的第四類）。外部工具
# （`pg_restore`／`psql`／`tar`／`mkdir`／`mktemp`／`rm`）之 stderr **一律**導入
# `/dev/null`，失敗改由本檔以摘要代碼回報——這是 T12R SF-4／SF-4-R 逐一補漏的
# 教訓：只管好自己的 `log`／`die` 不夠，外部工具會逐字把絕對路徑印出去。
#
# **已知未關之同族缺口（沿 T12R-2 AR-R2 據實記載）**：由 bash 自己發出的**重導向
# 失敗**訊息關不掉——`cmd > "$f" 2>/dev/null` 之中 `>` 先於 `2>` 建立，若目的地
# 唯讀／磁碟滿，bash 會以尚未被改寫的 stderr 印出 `bash: line N: <絕對路徑>:
# Permission denied`。本輪同樣**不實作**探測式修法（理由與 `backup.sh` :55-62
# 逐字相同：dev（Windows）無法穩定造出唯讀目的地，「改了但證不了」比「留著並寫
# 清楚」更糟）。`$RESTORE_VERIFY_LOG` 的追加重導向亦在此缺口內。
#
# ---------------------------------------------------------------------------
# ⚠ 射程限制（**不得被誤讀**）
# ---------------------------------------------------------------------------
# ① **還原成功 ≠ 涵蓋完整**。備份之 `coverage.allowEmpty=true`，或其
#    `tools.script` 早於 `PHASE-011-T12/2`（涵蓋自檢 fail-closed 之前的版本），
#    該備份的「該備的都備到了」沒有機械背書——此時紀錄帶 `coverage-unverified`
#    標記，且**不得**以本驗證之綠燈反推涵蓋完整（T12 交接 M-6+M-8）。
# ② **storage 主機可見前提**（沿 T12 SF-6 同型）：②項之附件抽樣把備份的 `att/`
#    ／`rpt/` 產物解到本機暫存目錄再讀，**假設執行本檔的主機讀得到備份目的地**。
#    備份若存放在只有容器看得到的 named volume，本檔不適用——該形態之替代步驟
#    歸 Runbook。
# ③ **`_prisma_migrations` 尾筆之判準**：本檔比對「還原目標之尾筆」與「**來源
#    現況**之尾筆」。備份之後若又部署了新 migration，這一格會（正確地）判為
#    `migration-tail-differs-from-source`——那代表這份備份還原回來的 schema 已
#    對不上今天的程式，是個真的該留紀錄的發現，不是誤報。處置歸 Runbook（改用
#    較新的備份重跑）。
# ④ **同實例之資源／磁碟風險（T13R SF-3）**：`RESTORE_TARGET_DATABASE_URL` 預設
#    多半與來源指向**同一個 PostgreSQL 實例**（本檔對此不作限制，B-19 只要求庫名
#    ／schema 不同）。那意味著每月演練期間，該實例上會**瞬間多出一份全庫副本**，
#    佔用等量磁碟直到 `DROP`；正式 volume 若已近水位，**一次演練就足以把正式服務
#    寫爆**。本檔不驗證容量，也無法在還原中途安全回頭。**建議以
#    `RESTORE_PG_CONTAINER` 指向一個獨立實例**（或至少獨立磁碟）；沿用同實例時，
#    演練前之可用空間檢核與時段選擇歸 Runbook（T14）。這條與 AC-21 的「備份不落在
#    正式資料樹內」是同一個道理的另一面：守門管的是路徑，管不到容量。
#
# ---------------------------------------------------------------------------
# 平台前提（同 `backup.sh`，D11-1(a) 之已知代價）
# ---------------------------------------------------------------------------
# 需要 `docker` 可達且來源與還原目標皆跑在容器內。受管 DB 不適用，替代指令歸
# Runbook。
#
# 用法：
#   BACKUP_DEST_ROOT=… DATABASE_URL=… RESTORE_TARGET_DATABASE_URL=… \
#   RESTORE_VERIFY_LOG=… scripts/verify-restore.sh
#
# 環境變數：
#   BACKUP_DEST_ROOT              【必要】備份目的地根目錄（取最近一份）
#   DATABASE_URL                  【必要】**正式**（來源）連線字串；全程唯讀
#   RESTORE_TARGET_DATABASE_URL   【必要】隔離還原目標（**不得**等於正式；其庫
#                                 名須尚未存在，本檔建立、用畢刪除）
#   RESTORE_VERIFY_LOG            【必要】驗證紀錄檔（追加，AC-24(b)）
#   RESTORE_BACKUP_ID             選用；指定要驗哪一份（預設取最近一份）
#   RESTORE_VERIFY_SCHEMA         選用；要驗的 schema（預設取 DATABASE_URL 之
#                                 `schema=`，再預設 `public`）
#   RESTORE_PG_CONTAINER          選用；還原目標所在容器名（非 localhost 時必要）
#   RESTORE_SOURCE_PG_CONTAINER   選用；來源所在容器名（非 localhost 時必要）
#   RESTORE_ALLOW_INCOMPLETE_SAMPLE 選用；`1` ＝明示承認「抽樣湊不出 ≥3／缺
#                                 thumb／缺修正版副本」而仍要繼續。**預設拒跑**
#                                 （走廊條款）；放行時紀錄帶 `sample-incomplete`。
#
# 結束碼：0＝三項全通過（並留成功紀錄）；非 0＝任一階段失敗（並留失敗紀錄）。
#
# ⚠ bash 陷阱紀律（沿 `backup.sh` 檔頭；PHASE-011-T10 三犯 ＋ T12R SF-2 之教訓）：
#   一律 `if ! cmd; then …; fi` 或 `X=$(cmd) || …`，**不寫 `cmd && die`**；
#   **不用 `{ …; …; } | … || die` 之群組 pipeline**（群組取最後一個命令之結束碼，
#   前面的失敗三道守門全不觸發）；不在 pipeline 尾端用 `head`。

set -euo pipefail

# T13R 之四項修法（形狀檢查上移至不可逆動作之前／降級綠燈換摘要碼／中斷紀錄記
# 實際結束碼與實際階段／同實例資源風險入檔頭）改變了本腳本的**行為與產物**，
# 故版號同步進位——沿 `backup.sh` 之 `SCRIPT_VERSION` 慣例。
SCRIPT_VERSION="PHASE-011-T13/2"

log() { printf '[verify-restore] %s\n' "$*"; }

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP_WORK=""
CREATED_DB=""
BACKUP_ID="unknown"
EVIDENCE="full"
RECORD_WRITTEN=0
# 中斷時之階段歸屬（T13R AR-2）：硬編 `guard` 會讓「還原到一半被 Ctrl-C」與
# 「前置守門就拒了」在紀錄上長得一樣。逐段推進，中斷紀錄取當下值。
CURRENT_STAGE="guard"
SRC_DB=""
TGT_DB=""
TGT_CONTAINER=""
TGT_USER=""

# ---------------------------------------------------------------------------
# 0. 前置：必要 env 與外部工具
# ---------------------------------------------------------------------------

for var in BACKUP_DEST_ROOT DATABASE_URL RESTORE_TARGET_DATABASE_URL RESTORE_VERIFY_LOG; do
  if [ -z "${!var:-}" ]; then
    printf '[verify-restore] ERROR: %s is required\n' "$var" >&2
    exit 2
  fi
done

for tool in docker tar node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '[verify-restore] ERROR: required tool not found: %s\n' "$tool" >&2
    exit 2
  fi
done

# 一律餵 stdin 而非給檔名（coreutils 在檔名含反斜線時會在整行前加一個跳脫用的
# `\`，Windows 路徑必踩）——與 `backup.sh` :153-164 同一份理由。
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 < "$1" | cut -d' ' -f1
  else
    printf '[verify-restore] ERROR: no sha256 tool found\n' >&2
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# 1. 判準模組之進入點（開發／CI 走原始碼，正式映像走 dist）——同 `backup.sh` :175
# ---------------------------------------------------------------------------

CHECK_SRC="$REPO_ROOT/backend/src/platform/restore-check.ts"
CHECK_DIST="$REPO_ROOT/backend/dist/platform/restore-check.js"
TSX_CLI="$REPO_ROOT/node_modules/tsx/dist/cli.mjs"

if [ -f "$TSX_CLI" ] && [ -f "$CHECK_SRC" ]; then
  CHECK_CMD=(node "$TSX_CLI" "$CHECK_SRC")
elif [ -f "$CHECK_DIST" ]; then
  CHECK_CMD=(node "$CHECK_DIST")
else
  printf '[verify-restore] ERROR: restore-check entry not found\n' >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 2. 紀錄與清理（AC-24；不可逆動作之收尾）
# ---------------------------------------------------------------------------

# 空格分隔之 `k=v` 取值。值不得含空白——本檔取用的都是識別字與雜湊。
field() { printf '%s' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"; }

write_record() { # $1=stage $2=summary $3=exit-code
  local line
  if line=$(printf '%s\n' \
    "RECORD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "RECORD_BACKUP_ID=$BACKUP_ID" \
    "RECORD_STAGE=$1" \
    "RECORD_SUMMARY=$2" \
    "RECORD_EXIT_CODE=$3" \
    "RECORD_EVIDENCE=$EVIDENCE" | "${CHECK_CMD[@]}" record); then
    # **追加**（AC-24(b)）：`>>` 不覆蓋。判準端已驗過每一欄的形狀，寫不出格式壞
    # 掉的紀錄——一筆壞紀錄會讓日後誤以為「那個月跑過了」，比沒有紀錄更糟。
    printf '%s\n' "$line" >> "$RESTORE_VERIFY_LOG"
    RECORD_WRITTEN=1
  else
    log "ERROR: the verification record could not be formatted (nothing appended)"
  fi
}

drop_target() {
  # 不可逆動作之最後一道：只刪本次親手建立的那一個，且它必須不是來源庫。
  if [ -z "$CREATED_DB" ] || [ "$CREATED_DB" = "$SRC_DB" ]; then return 0; fi
  if docker exec -i "$TGT_CONTAINER" psql -U "$TGT_USER" -d postgres -tAc \
    "DROP DATABASE IF EXISTS \"$CREATED_DB\" WITH (FORCE)" >/dev/null 2>&1; then
    CREATED_DB=""
    log "target=dropped"
  else
    log "ERROR: the isolated restore target could not be dropped (see RESTORE_TARGET_DATABASE_URL)"
  fi
}

cleanup() {
  # **T13R AR-2**：`$?` 必須在 trap 一進來就取——下面每一個命令都會覆寫它。原本
  # 中斷紀錄把結束碼硬編成 1，與行程實際回給排程器的碼可以不一致（即審探針實測：
  # 紀錄 1、實出 2），排障時對不上。
  local rc=$?
  drop_target
  if [ -n "$TMP_WORK" ] && [ -d "$TMP_WORK" ]; then rm -rf "$TMP_WORK" 2>/dev/null || true; fi
  # 半途中斷（Ctrl-C／排程器 timeout）同樣是一次「沒跑完」的演練，必須留下紀錄，
  # 否則稽核時看不出這個月試過但被打斷（AC-24(a) 之同一理由）。
  #
  # **T13R2 NF-1**：這個補救條件原本是
  # `[ "$COMPLETED" -eq 0 ] && [ "$RECORD_WRITTEN" -eq 0 ]`，而 `COMPLETED=1` 設在
  # 最後那次 `write_record` **之前**——於是「三項都跑完了、但紀錄沒寫成」
  # （`COMPLETED=1` ∧ `RECORD_WRITTEN=0`）這個組合會把補救分支**自己關掉**，該次
  # 演練零紀錄，正是上面兩行註解要防的事。判準只該有一個：**這次執行到底有沒有
  # 留下紀錄**。`COMPLETED` 因而失去讀者，一併移除（write-only 的旗標比沒有旗標
  # 更容易讓人以為它還在守著什麼）。正常路徑 `RECORD_WRITTEN=1`，不會多寫一筆。
  if [ "$RECORD_WRITTEN" -eq 0 ]; then
    # 沒留下紀錄卻回 0 是不該發生的組合；真出現時記 1，不讓一筆 `exitCode: 0` 的
    # 中斷紀錄被當成成功（AC-24(a) 之「非零結束碼」不得被繞過）。
    if [ "$rc" -eq 0 ]; then rc=1; fi
    write_record "$CURRENT_STAGE" "verification-interrupted" "$rc"
    # 紀錄與行程結束碼不得各說各話（T13R AR-2 之同一條紀律）：一次沒能留下紀錄的
    # 演練不算成功演練，故行程也回 `$rc`。在 EXIT trap 裡 `exit` 只改最終狀態碼，
    # 不會再次觸發本 trap。
    exit "$rc"
  fi
}
trap cleanup EXIT
# T12R AR-2 同型：只掛 EXIT 時 INT／TERM 會讓 bash 直接收攤而不跑 EXIT trap，
# 隔離資料庫就留在實例上了。兩訊號轉成正常 `exit`，清理只有一份實作。
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { # $1=stage $2=summary-code
  write_record "$1" "$2" 1
  log "ERROR: stage=$1 summary=$2"
  exit 1
}

# 判準模組失敗時，其 stderr 首欄即摘要代碼。取不到就退回一個**明確的**代碼，
# 不留空——空摘要會被 `record` 判準拒收，於是那次失敗連紀錄都沒有（AC-24(a) 之
# 反面）。「取不到代碼」本身也是一種失敗，必須有名字。
summary_of() { # $1=stderr 內容 $2=退路代碼
  local code
  code=$(printf '%s' "$1" | sed -n 's/^summary=\([a-z0-9-]*\).*/\1/p' | sed -n '1p')
  if [ -z "$code" ]; then code="$2"; fi
  printf '%s' "$code"
}

TMP_WORK=$(mktemp -d 2>/dev/null) || {
  printf '[verify-restore] ERROR: cannot create a temporary working directory\n' >&2
  exit 2
}
ERR_FILE="$TMP_WORK/tool.err"

# ---------------------------------------------------------------------------
# 3. 前置守門（B-19 三元組 ＋ 三個識別字之形狀；判準在 TS）
# ---------------------------------------------------------------------------
# **T13R SF-1**：`RESTORE_VERIFY_SCHEMA` 一併在這裡交出去驗形狀並取回有效值——
# 它是使用者可覆寫的值，形狀不對時必須在**建庫之前**就拒。本檔因此不自行套用
# 「沒設就用來源 schema」這條預設（那會讓有效值有兩份來源而可能漂移）。

TARGET_SETTINGS=$(printf '%s\n' \
  "DATABASE_URL=$DATABASE_URL" \
  "RESTORE_TARGET_DATABASE_URL=$RESTORE_TARGET_DATABASE_URL" \
  "RESTORE_VERIFY_SCHEMA=${RESTORE_VERIFY_SCHEMA:-}")

if ! TARGET_INFO=$(printf '%s\n' "$TARGET_SETTINGS" | "${CHECK_CMD[@]}" check-target 2>"$ERR_FILE"); then
  GUARD_MSG=$(cat "$ERR_FILE" 2>/dev/null || true)
  printf '%s\n' "$GUARD_MSG" >&2
  fail "guard" "$(summary_of "$GUARD_MSG" "restore-target-unusable")"
fi

SRC_HOST=$(field "$TARGET_INFO" "src.host")
SRC_PORT=$(field "$TARGET_INFO" "src.port")
SRC_USER=$(field "$TARGET_INFO" "src.user")
SRC_DB=$(field "$TARGET_INFO" "src.db")
TGT_HOST=$(field "$TARGET_INFO" "tgt.host")
TGT_PORT=$(field "$TARGET_INFO" "tgt.port")
TGT_USER=$(field "$TARGET_INFO" "tgt.user")
TGT_DB=$(field "$TARGET_INFO" "tgt.db")
# 有效值來自判準端（已驗形狀）——本檔零推導（T13R SF-1）。
VERIFY_SCHEMA=$(field "$TARGET_INFO" "verify.schema")

# ---------------------------------------------------------------------------
# 4. 找出承載來源與目標之容器（同 `backup.sh` :244 之探索法）
# ---------------------------------------------------------------------------

discover_container() { # $1=port $2=host $3=override $4=env-name
  if [ -n "$3" ]; then printf '%s' "$3"; return 0; fi
  case "$2" in
    localhost | 127.0.0.1 | ::1 | host.docker.internal) ;;
    *) return 1 ;;
  esac
  local names count
  names=$(docker ps --filter "publish=$1" --format '{{.Names}}' 2>/dev/null) || return 1
  count=$(printf '%s' "$names" | grep -c . || true)
  if [ "$count" -ne 1 ]; then return 1; fi
  printf '%s' "$names"
}

if ! SRC_CONTAINER=$(discover_container "$SRC_PORT" "$SRC_HOST" "${RESTORE_SOURCE_PG_CONTAINER:-}"); then
  fail "guard" "restore-target-unusable"
fi
if ! TGT_CONTAINER=$(discover_container "$TGT_PORT" "$TGT_HOST" "${RESTORE_PG_CONTAINER:-}"); then
  fail "guard" "restore-target-unusable"
fi

# ---------------------------------------------------------------------------
# 5. 取最近一份備份 ＋ 讀其證據等級（M-6+M-8）
# ---------------------------------------------------------------------------

PICK_SETTINGS=$(printf '%s\n' \
  "BACKUP_DEST_ROOT=$BACKUP_DEST_ROOT" \
  "RESTORE_BACKUP_ID=${RESTORE_BACKUP_ID:-}")

if ! PICK_INFO=$(printf '%s\n' "$PICK_SETTINGS" | "${CHECK_CMD[@]}" pick-backup 2>"$ERR_FILE"); then
  PICK_MSG=$(cat "$ERR_FILE" 2>/dev/null || true)
  printf '%s\n' "$PICK_MSG" >&2
  fail "guard" "$(summary_of "$PICK_MSG" "backup-not-found")"
fi

BACKUP_ID=$(field "$PICK_INFO" "backup-id")
EVIDENCE=$(field "$PICK_INFO" "evidence")
BACKUP_DIR="$BACKUP_DEST_ROOT/$BACKUP_ID"
log "start id=$BACKUP_ID evidence=$EVIDENCE schema-scope=RESTORE_VERIFY_SCHEMA version=$SCRIPT_VERSION"

# ---------------------------------------------------------------------------
# 6. ①「資料庫可開啟」（AC-23(a)）
# ---------------------------------------------------------------------------
# 順序刻意如此：**先驗產物、再動資料庫**。雜湊那一步不需要建立任何東西，把它放
# 在 `CREATE DATABASE` 之前，損毀備份就不會在實例上留下半個空庫（B-20 之兩個
# mutant 各自證明了這條順序：改位元組者連庫都沒建，截斷 tar 者建了但被 trap 刪掉）。

CURRENT_STAGE="a"
EXPECTED_DB_SHA=$(field "$PICK_INFO" "sha.db.dump")
ACTUAL_DB_SHA=$(sha256_of "$BACKUP_DIR/db.dump")
if [ "$EXPECTED_DB_SHA" != "$ACTUAL_DB_SHA" ]; then
  fail "a" "db-dump-hash-mismatch"
fi

if docker exec -i "$TGT_CONTAINER" psql -U "$TGT_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$TGT_DB'" 2>/dev/null | grep -q '^1$'; then
  fail "a" "restore-target-database-exists"
fi

if ! docker exec -i "$TGT_CONTAINER" psql -U "$TGT_USER" -d postgres -tAc \
  "CREATE DATABASE \"$TGT_DB\"" >/dev/null 2>&1; then
  fail "a" "create-database-failed"
fi
CREATED_DB="$TGT_DB"
log "target=created"

# `-Fc` 之 TOC 需可 seek，故把產物送進容器暫存檔再還原（讀完即刪，同 T12 之手法）。
if ! docker exec -i "$TGT_CONTAINER" sh -c \
  'f=$(mktemp) && cat > "$f" && pg_restore -U "$1" -d "$2" --no-owner --exit-on-error "$f" >/dev/null 2>&1; rc=$?; rm -f "$f" 2>/dev/null; exit $rc' \
  sh "$TGT_USER" "$TGT_DB" < "$BACKUP_DIR/db.dump" 2>/dev/null; then
  fail "a" "pg-restore-failed"
fi

TAIL_SQL=$(printf '%s\n' "RESTORE_VERIFY_SCHEMA=$VERIFY_SCHEMA" | "${CHECK_CMD[@]}" sql-migration-tail)

if ! RESTORED_TAIL=$(docker exec -i "$TGT_CONTAINER" psql -U "$TGT_USER" -d "$TGT_DB" -tAc "$TAIL_SQL" 2>/dev/null); then
  fail "a" "restored-database-unreachable"
fi
RESTORED_TAIL=$(printf '%s' "$RESTORED_TAIL" | tr -d '\r\n')
if [ -z "$RESTORED_TAIL" ]; then
  # 走廊條款：讀不到尾筆 ≠ 尾筆相符。
  fail "a" "migration-tail-missing"
fi

if ! SOURCE_TAIL=$(docker exec -i "$SRC_CONTAINER" psql -U "$SRC_USER" -d "$SRC_DB" -tAc "$TAIL_SQL" 2>/dev/null); then
  fail "a" "migration-tail-missing"
fi
SOURCE_TAIL=$(printf '%s' "$SOURCE_TAIL" | tr -d '\r\n')
if [ "$RESTORED_TAIL" != "$SOURCE_TAIL" ]; then
  fail "a" "migration-tail-differs-from-source"
fi
log "(a) db-opened=yes migration-tail=match"

# ---------------------------------------------------------------------------
# 7. ②「附件可讀取」（AC-23(b)／B-21）
# ---------------------------------------------------------------------------

CURRENT_STAGE="b"
PARTS_VERIFIED=1 # db.dump 已於 ① 驗過
for archive in attachments reports; do
  expected=$(field "$PICK_INFO" "sha.$archive.tar")
  if [ "$expected" != "$(sha256_of "$BACKUP_DIR/$archive.tar")" ]; then
    fail "b" "archive-hash-mismatch"
  fi
  PARTS_VERIFIED=$((PARTS_VERIFIED + 1))
done

RESTORED_STORAGE="$TMP_WORK/restored"
if ! mkdir -p "$RESTORED_STORAGE" 2>/dev/null; then fail "b" "archive-extract-failed"; fi
for archive in attachments reports; do
  # 逐個解、逐個守門（T12R SF-2：群組 pipeline 會吞掉第一個失敗）。
  if ! tar -C "$RESTORED_STORAGE" -xf - < "$BACKUP_DIR/$archive.tar" 2>/dev/null; then
    fail "b" "archive-extract-failed"
  fi
done

OBJECT_SQL=$(printf '%s\n' "RESTORE_VERIFY_SCHEMA=$VERIFY_SCHEMA" | "${CHECK_CMD[@]}" sql-objects)
if ! OBJECT_ROWS=$(docker exec -i "$TGT_CONTAINER" psql -U "$TGT_USER" -d "$TGT_DB" -tAc "$OBJECT_SQL" 2>/dev/null); then
  fail "b" "restored-database-unreachable"
fi

SAMPLE_OUT=""
SAMPLE_OK=0
if SAMPLE_OUT=$(printf '%s\n%s\n%s\n' \
  "RESTORE_VERIFY_SCHEMA=$VERIFY_SCHEMA" "--payload--" "$OBJECT_ROWS" |
  "${CHECK_CMD[@]}" check-sample 2>/dev/null); then
  SAMPLE_OK=1
fi

if [ "$SAMPLE_OK" -eq 0 ]; then
  # 走廊條款：抽不到樣本**不得**與「抽樣通過」同結局。維運人員可明示承認而放行，
  # 但該次紀錄必帶降級標記（沿 `backup.sh` 之 `BACKUP_ALLOW_EMPTY` 同一形狀）。
  if [ "${RESTORE_ALLOW_INCOMPLETE_SAMPLE:-}" != "1" ]; then
    fail "b" "attachment-sample-unavailable"
  fi
  if [ "$EVIDENCE" = "full" ]; then EVIDENCE="sample-incomplete"; else EVIDENCE="$EVIDENCE,sample-incomplete"; fi
  log "(b) parts-verified=$PARTS_VERIFIED; sample n=0 thumb=0 revision=0 readable=0 allow-incomplete=yes (unverifiable sample, explicitly acknowledged)"
else
  SAMPLE_SUMMARY=$(printf '%s' "$SAMPLE_OUT" | sed -n '1p')
  READABLE=0
  while IFS= read -r key; do
    key="${key%$'\r'}"
    if [ -z "$key" ]; then continue; fi
    # B-21：還原之 storage 少了這個鍵 → (b) 失敗。刻意不印是哪一個鍵（禁字第四類）。
    if [ ! -s "$RESTORED_STORAGE/$key" ]; then
      fail "b" "attachment-object-missing"
    fi
    READABLE=$((READABLE + 1))
  done <<< "$(printf '%s' "$SAMPLE_OUT" | sed -n '2,$p')"
  log "(b) parts-verified=$PARTS_VERIFIED; $SAMPLE_SUMMARY readable=$READABLE"
fi

# ---------------------------------------------------------------------------
# 8. ③「主要資料關聯存在」（AC-23(c)；D13=(a)+(b) 併用）
# ---------------------------------------------------------------------------

CURRENT_STAGE="c"
RELATION_SQL=$(printf '%s\n' "RESTORE_VERIFY_SCHEMA=$VERIFY_SCHEMA" | "${CHECK_CMD[@]}" sql-relations)
if ! RELATION_ROWS=$(docker exec -i "$TGT_CONTAINER" psql -U "$TGT_USER" -d "$TGT_DB" -tAc "$RELATION_SQL" 2>/dev/null); then
  fail "c" "relation-query-failed"
fi

if ! RELATION_OUT=$(printf '%s\n%s\n%s\n' \
  "RESTORE_VERIFY_SCHEMA=$VERIFY_SCHEMA" "--payload--" "$RELATION_ROWS" |
  "${CHECK_CMD[@]}" check-relations 2>"$ERR_FILE"); then
  RELATION_MSG=$(cat "$ERR_FILE" 2>/dev/null || true)
  printf '%s\n' "$RELATION_MSG" >&2
  fail "c" "$(summary_of "$RELATION_MSG" "relation-query-failed")"
fi
log "(c) $(printf '%s' "$RELATION_OUT" | sed -n '1p')"

# ---------------------------------------------------------------------------
# 9. 全通過（AC-24(c)：成功亦留紀錄）
# ---------------------------------------------------------------------------

CURRENT_STAGE="none"

# **T13R SF-2**：成功摘要依證據等級二選一。`evidence` 一旦不是 `full`，就有某一項
# 確認**沒有真的執行**（今日唯一的入口是 `RESTORE_ALLOW_INCOMPLETE_SAMPLE=1` 之下
# 的 (b) 項），此時再寫「三項全過」，主欄位本身就是假的——而那個旗標一旦常設在
# 排程器的 env 裡，這句假話會每個月靜默重複一次。摘要與證據之耦合另由 `record`
# 判準雙向釘死，本檔選錯碼會被它擋下來（寫不出紀錄，不會靜默通過）。
if [ "$EVIDENCE" = "full" ]; then
  PASS_SUMMARY="all-three-confirmations-passed"
else
  PASS_SUMMARY="confirmations-passed-with-degraded-evidence"
fi
write_record "none" "$PASS_SUMMARY" 0
log "done id=$BACKUP_ID result=pass summary=$PASS_SUMMARY evidence=$EVIDENCE"
