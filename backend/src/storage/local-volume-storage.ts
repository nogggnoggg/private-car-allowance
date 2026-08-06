/**
 * LocalVolumeStorage — PHASE-003-T2; prefix whitelist parameterised PHASE-008-T8a
 *
 * Implements the Storage interface using the local filesystem.
 * Root path is provided via env ATTACHMENT_STORAGE_ROOT (attachment instance)
 * or REPORT_STORAGE_ROOT (report instance, PHASE-008).
 *
 * Key design decisions (Spec §4.1 §13-T2; prefix parameterisation Spec §9.4/AC-26):
 *   - key → file path mapping: `<root>/<key>` where key uses `/` separators.
 *     On Windows the separator is converted to the platform separator.
 *   - Key WHITELIST validation: only keys matching `<prefix>/<segment>/<segment>`
 *     for one of the instance's configured `prefixes` are accepted. This is the
 *     PRIMARY defence. A secondary normalisation check confirms the resolved
 *     path stays within root.
 *   - `prefixes` is a closed set passed via the constructor's `options.prefixes`
 *     (default `["att"]` — unchanged from the original hardcoded behaviour).
 *     Instances configured with different prefix sets reject each other's keys
 *     (e.g. an `["att"]` instance rejects `rpt/...` and vice versa, AC-26).
 *   - Rejected keys: `..`, absolute paths, backslash, null bytes, empty, leading/
 *     trailing slash, URL-encoded sequences, control characters.
 *   - Root not existing: auto-created on first put (mkdirSync recursive).
 *   - get non-existent key: throws Error (documented behaviour, see Storage interface).
 *   - delete non-existent key: resolves without error (idempotent).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Storage } from "./storage.js";

/** Default prefix whitelist — unchanged from the original hardcoded `att` behaviour. */
const DEFAULT_PREFIXES = ["att"];

export interface LocalVolumeStorageOptions {
  /**
   * Closed set of accepted key prefixes (e.g. `["att"]`, `["rpt"]`).
   * Defaults to `["att"]` when omitted.
   */
  prefixes?: string[];
}

/** Escape a literal string for safe use inside a RegExp alternation. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the whitelist pattern for a closed set of prefixes.
 *
 * Accepted format:  <prefix>/<id>/<suffix>
 *   - `<prefix>/` literal, one of the configured `prefixes`
 *   - `<id>`:    one or more chars from [a-zA-Z0-9_-] (cuid2, cuid, uuid-compatible)
 *   - `/`        separator
 *   - `<suffix>`: one or more chars from [a-zA-Z0-9_-] (e.g. `original`, `thumb`, `pdf`)
 *
 * This intentionally ONLY accepts the above — it is not a general key scheme.
 * Any deviation (traversal, extra segments, a prefix outside the closed set, etc.)
 * is rejected.
 */
function buildKeyRegex(prefixes: string[]): RegExp {
  const alternation = prefixes.map(escapeRegExp).join("|");
  return new RegExp(`^(?:${alternation})\\/[a-zA-Z0-9_-]+\\/[a-zA-Z0-9_-]+$`);
}

/**
 * Validate a storage key against the instance's system-generated whitelist.
 *
 * Throws with a descriptive message if the key is invalid.
 * This is the PRIMARY path-traversal defence: reject at the key level before
 * any filesystem path is constructed.
 */
function validateKey(key: string, keyRegex: RegExp): void {
  // Guard: must be a non-empty string
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Invalid storage key: key must be a non-empty string");
  }

  // Guard: no null bytes
  if (key.includes("\x00")) {
    throw new Error("Invalid storage key: key must not contain null bytes");
  }

  // Guard: no control characters (covers \n, \r, \t, etc.)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we're rejecting control chars
  if (/[\x00-\x1f\x7f]/.test(key)) {
    throw new Error("Invalid storage key: key must not contain control characters");
  }

  // Guard: no backslashes (Windows path separator — not allowed in keys)
  if (key.includes("\\")) {
    throw new Error("Invalid storage key: key must not contain backslashes");
  }

  // Guard: no URL-encoded sequences (e.g. %2e%2e for `..`)
  if (/%[0-9a-fA-F]{2}/.test(key)) {
    throw new Error("Invalid storage key: key must not contain URL-encoded sequences");
  }

  // PRIMARY WHITELIST: key must match the exact system-generated format
  // for one of this instance's configured prefixes.
  if (!keyRegex.test(key)) {
    throw new Error(
      `Invalid storage key: key does not match the allowed format (<prefix>/<id>/<suffix>). Got: ${JSON.stringify(key)}`
    );
  }
}

export class LocalVolumeStorage implements Storage {
  private readonly root: string;
  private readonly keyRegex: RegExp;

  /**
   * @param root    - Absolute path to the storage root directory.
   *                  Provided by env ATTACHMENT_STORAGE_ROOT (attachment instance)
   *                  or REPORT_STORAGE_ROOT (report instance).
   * @param options - `{ prefixes }`: closed set of accepted key prefixes.
   *                  Defaults to `["att"]` — unchanged from the original behaviour.
   */
  constructor(root: string, options: LocalVolumeStorageOptions = {}) {
    // Normalise to an absolute path for consistent comparison
    this.root = path.resolve(root);
    const prefixes = options.prefixes ?? DEFAULT_PREFIXES;
    this.keyRegex = buildKeyRegex(prefixes);
  }

  /**
   * Resolve a validated key to its absolute filesystem path.
   * Also performs a secondary containment check (belt-and-suspenders).
   */
  private resolvePath(key: string): string {
    validateKey(key, this.keyRegex); // PRIMARY defence — throws on invalid keys

    // Convert forward-slash key to platform-native path
    const relativePath = key.split("/").join(path.sep);
    const resolved = path.resolve(this.root, relativePath);

    // SECONDARY containment check: resolved path must start with root
    // (with trailing sep to prevent "root_extra" matching "root")
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (!resolved.startsWith(rootWithSep) && resolved !== this.root) {
      // This should never be reached after whitelist validation, but defence-in-depth
      throw new Error(
        `Invalid storage key: resolved path escapes root directory. Key: ${JSON.stringify(key)}`
      );
    }

    return resolved;
  }

  async put(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    const filePath = this.resolvePath(key);
    const dir = path.dirname(filePath);

    // Auto-create root and intermediate directories
    fs.mkdirSync(dir, { recursive: true });

    // Write atomically-enough for our use case: write to file
    fs.writeFileSync(filePath, bytes);
  }

  async get(key: string): Promise<Buffer> {
    const filePath = this.resolvePath(key);

    // Throws if file does not exist — documented behaviour
    if (!fs.existsSync(filePath)) {
      throw new Error(`Storage key not found: ${JSON.stringify(key)}`);
    }

    return fs.readFileSync(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);

    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      // Idempotent: swallow ENOENT (file already gone)
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    return fs.existsSync(filePath);
  }
}
