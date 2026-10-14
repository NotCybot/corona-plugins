import { type JsonValue, getState } from 'corona/plugin';
import type { Cast, CastOptions, Snapshot } from './service.ts';

export function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStrings(value: JsonValue): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export function isCastOptions(value: JsonValue): value is CastOptions {
  return isObject(value) && typeof value.res === 'number';
}

function isSnapshot(value: JsonValue): value is Snapshot {
  return isObject(value) && Array.isArray(value.devices);
}

function isCasts(value: JsonValue): value is Record<string, Cast> {
  return isObject(value) && Object.values(value).every(isObject);
}

function isVolumes(value: JsonValue): value is Record<string, number> {
  return (
    isObject(value) && Object.values(value).every((v) => typeof v === 'number')
  );
}

/** State `kc`, null before the service's first refresh */
export function snapshot(): Snapshot | null {
  const value = getState('kc');
  return isSnapshot(value) ? value : null;
}

/** State `cast` */
export function castStates(): Record<string, Cast> {
  const value = getState('cast');
  return isCasts(value) ? value : {};
}

/** State `unmute`: the volume before muting, by device id */
export function unmuteVolumes(): Record<string, number> {
  const value = getState('unmute');
  return isVolumes(value) ? value : {};
}

/** State `msg`, the line of the last call */
export function statusLine(): string | null {
  const value = getState('msg');
  return typeof value === 'string' ? value : null;
}
