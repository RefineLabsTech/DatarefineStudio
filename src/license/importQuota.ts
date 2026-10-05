import type { LicenseSnapshot } from "./types";

/** Basic mode allows ten successful file imports in a rolling thirty-day window. */
export const BASIC_FILE_IMPORT_LIMIT = 10;
export const BASIC_FILE_IMPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const STORAGE_KEY = "drs.basic-file-imports.v1";

let nextReservationId = 1;
const pendingReservations = new Set<number>();
let volatileEvents: number[] = [];

type StoredEvents = number[] | null;

export type BasicFileImportStatus = {
  limited: boolean;
  storageAvailable: boolean;
  used: number;
  remaining: number;
  limit: number;
  windowDays: number;
};

export type BasicFileImportReservation = {
  id: number;
} | null;

function isBasicMode(snap: LicenseSnapshot | null | undefined) {
  return Boolean(snap?.requireLicense && (snap.decision === "basic" || snap.basicMode));
}

function prune(events: number[], now = Date.now()) {
  const cutoff = now - BASIC_FILE_IMPORT_WINDOW_MS;
  return events.filter((timestamp) => Number.isFinite(timestamp) && timestamp > cutoff);
}

function readEvents(): StoredEvents {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const events = prune(parsed.map((value) => Number(value)));
    if (events.length !== parsed.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    }
    return events;
  } catch {
    return null;
  }
}

function writeEvents(events: number[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prune(events)));
    return true;
  } catch {
    return false;
  }
}

export function basicFileImportStatus(snap: LicenseSnapshot | null | undefined): BasicFileImportStatus {
  if (!isBasicMode(snap)) {
    return {
      limited: false,
      storageAvailable: true,
      used: 0,
      remaining: Number.POSITIVE_INFINITY,
      limit: BASIC_FILE_IMPORT_LIMIT,
      windowDays: 30,
    };
  }

  volatileEvents = prune(volatileEvents);
  const events = readEvents();
  if (!events) {
    return {
      limited: true,
      storageAvailable: false,
      used: BASIC_FILE_IMPORT_LIMIT,
      remaining: 0,
      limit: BASIC_FILE_IMPORT_LIMIT,
      windowDays: 30,
    };
  }

  const used = events.length + volatileEvents.length + pendingReservations.size;
  return {
    limited: true,
    storageAvailable: true,
    used,
    remaining: Math.max(0, BASIC_FILE_IMPORT_LIMIT - used),
    limit: BASIC_FILE_IMPORT_LIMIT,
    windowDays: 30,
  };
}

/** Reserve a slot before starting an import; it is counted only on success. */
export function beginBasicFileImport(snap: LicenseSnapshot | null | undefined): {
  allowed: boolean;
  reservation: BasicFileImportReservation;
  status: BasicFileImportStatus;
  reason?: string;
} {
  const status = basicFileImportStatus(snap);
  if (!status.limited) {
    return { allowed: true, reservation: null, status };
  }
  if (!status.storageAvailable) {
    return {
      allowed: false,
      reservation: null,
      status,
      reason: "Basic import quota storage is unavailable. The file was not imported.",
    };
  }
  if (status.remaining <= 0) {
    return {
      allowed: false,
      reservation: null,
      status,
      reason: `Basic mode allows ${BASIC_FILE_IMPORT_LIMIT} successful file imports in any 30-day period. Try again after an earlier import leaves the rolling window.`,
    };
  }

  const reservation = { id: nextReservationId++ };
  pendingReservations.add(reservation.id);
  return { allowed: true, reservation, status };
}

/** Complete a reservation. Failed imports do not consume a Basic slot. */
export function finishBasicFileImport(reservation: BasicFileImportReservation, successful: boolean) {
  if (!reservation || !pendingReservations.delete(reservation.id) || !successful) return;
  const events = readEvents();
  if (!events) return;
  const timestamp = Date.now();
  const next = [...events, ...volatileEvents, timestamp];
  if (writeEvents(next)) {
    volatileEvents = [];
  } else {
    volatileEvents.push(timestamp);
  }
}

export function basicFileImportMessage(snap: LicenseSnapshot | null | undefined) {
  const status = basicFileImportStatus(snap);
  if (!status.limited) return "";
  if (!status.storageAvailable) return "Basic file import quota is unavailable.";
  return `${status.remaining.toLocaleString()} of ${status.limit.toLocaleString()} Basic file imports remaining in the rolling 30-day window.`;
}
