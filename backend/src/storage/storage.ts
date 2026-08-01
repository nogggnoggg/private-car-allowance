/**
 * Storage interface — PHASE-003 §4.1
 *
 * Abstraction layer for attachment byte storage. Business logic depends only
 * on this interface; switching backends (local volume → S3, etc.) requires
 * only a new implementing class and env change, never touching business code.
 *
 * Key contract:
 *   - `key` is always a system-generated string in the format `att/<id>/original`
 *     or `att/<id>/thumb`. It MUST NOT contain user input.
 *   - All methods are async and return Promises.
 *   - Implementations MUST validate the key and reject any traversal attempt.
 */
export interface Storage {
  /**
   * Write bytes to storage under the given key.
   * Creates any necessary intermediate structures (directories, prefixes, etc.).
   * Overwrites existing content if the key already exists.
   *
   * @param key         - System-generated storage key (e.g. `att/<cuid>/original`)
   * @param bytes       - Raw content as a Buffer
   * @param contentType - MIME type (e.g. `image/jpeg`); stored for metadata
   */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;

  /**
   * Retrieve bytes stored under the given key.
   *
   * Defined behaviour (recorded in Handoff):
   *   - If the key does NOT exist: throws an Error.
   *   - If the key exists: resolves with a Buffer.
   *
   * @param key - System-generated storage key
   * @returns Buffer with the stored bytes
   * @throws Error if the key does not exist or cannot be read
   */
  get(key: string): Promise<Buffer | NodeJS.ReadableStream>;

  /**
   * Delete the content stored under the given key.
   * Idempotent: does NOT throw if the key does not exist.
   *
   * @param key - System-generated storage key
   */
  delete(key: string): Promise<void>;

  /**
   * Check whether content exists under the given key.
   *
   * @param key - System-generated storage key
   * @returns true if the key exists, false otherwise
   */
  exists(key: string): Promise<boolean>;
}
