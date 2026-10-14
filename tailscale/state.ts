import { type JsonValue, getState } from 'corona/plugin';
import type { Recent, Snapshot } from './service.ts';

export function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSnapshot(value: JsonValue): value is Snapshot {
  return isObject(value) && 'conn' in value;
}

function isRecent(value: JsonValue): value is Recent[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isObject(item) && 'file' in item)
  );
}

/** State `ts`, null before the service's first refresh */
export function snapshot(): Snapshot | null {
  const value = getState('ts');
  return isSnapshot(value) ? value : null;
}

/** State `recent`, newest first */
export function recent(): Recent[] {
  const value = getState('recent');
  return isRecent(value) ? value : [];
}

/** State `msg`, the line of the last call */
export function message(): string | null {
  const value = getState('msg');
  return typeof value === 'string' ? value : null;
}
