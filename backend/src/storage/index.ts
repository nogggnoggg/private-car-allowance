/**
 * Storage module public API — PHASE-003-T2
 *
 * Re-exports the Storage interface and the LocalVolumeStorage implementation.
 * T3/T5 and future Tasks import from here.
 */
export type { Storage } from "./storage.js";
export { LocalVolumeStorage } from "./local-volume-storage.js";
