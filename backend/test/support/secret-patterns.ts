/**
 * PHASE-011-T17／AC-29(c)（D16-2）：敏感字面掃描器 pattern（AC-12）之單一共用來源。
 *
 * ---------------------------------------------------------------------------
 * 收斂前之重複（`KNOWN_ISSUES.md` :52 D-7「日誌掃描器 pattern 收斂」實查結果）
 * ---------------------------------------------------------------------------
 * `phase11-env-secrets.test.ts`（AC-12 掃描器之正本）與
 * `phase11-backup-restore.test.ts`（AC-22(a)「備份產物與腳本日誌經**同一
 * 掃描器**」之要求）各自宣告一份逐字相同之四條 pattern。後者原檔頭註解自
 * 陳：「這四條與 `phase11-env-secrets.test.ts` 之 `SECRET_PATTERNS` 必須逐字
 * 相同……該檔為既有測試，本 Task 不得修改，故以複製 ＋ 機械比對代替
 * import」（T12/T13 當時前者為該 Task 之 Files Forbidden）。本檔為該複製之
 * 單一收斂點，兩檔皆改為 import 本檔；四條 pattern 之 `id`／`regex` 逐字不
 * 變（`phase11-backup-restore.test.ts` 原「逐字同一份」機械比對格已改為驗證
 * 兩檔皆從本檔匯入同一常數，見該檔 AC-22(a) 相關 it）。
 *
 * ---------------------------------------------------------------------------
 * AC-12(a) 之四類樣式，逐條對應 Spec 原文（沿 phase11-env-secrets.test.ts
 * 原檔頭逐字複製，兩檔共用同一組理由）
 * ---------------------------------------------------------------------------
 *   `conn-string`  ← 「`postgres(ql)?://<user>:<非空密碼>@`」
 *   `private-key`  ← 「`-----BEGIN * PRIVATE KEY-----`」
 *   `argon2-hash`  ← 「`$argon2` 雜湊字面」
 *   `long-secret`  ← 「長度 ≥32 之 base64／hex 且鍵名含 `secret|token|key|password`」
 *
 * `argon2-hash` 刻意要求**完整自描述字面**（六段 ＋ salt ≥16 ＋ hash ≥22 之
 * base64 字元），而不是只認 `$argon2` 前綴。理由：本倉庫的文件裡有大量「以
 * `$argon2` 前綴為掃描對象」的**敘述**（`DATA_FLOW.md`、`PHASE-002/010.md`），
 * 只認前綴會讓白名單膨脹成「把四個 docs 檔整個放行」，那反而讓真正貼進這些檔
 * 案的雜湊被放過。認完整形狀則只有真正的雜湊字面會命中。
 */
export type SecretPattern = { readonly id: string; readonly regex: RegExp };

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: "conn-string", regex: /postgres(?:ql)?:\/\/[^\s:/@'"`]+:[^\s@'"`]+@/g },
  { id: "private-key", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  {
    id: "argon2-hash",
    regex: /\$argon2(?:id|i|d)\$[^$\s]+\$[^$\s]+\$[A-Za-z0-9+/]{16,}\$[A-Za-z0-9+/]{22,}/g,
  },
  {
    id: "long-secret",
    regex: /(?:secret|token|key|password)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[A-Za-z0-9+/=]{32,}/gi,
  },
];
