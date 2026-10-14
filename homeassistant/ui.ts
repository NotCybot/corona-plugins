import { div } from 'gpui-kit';
import type { Color } from 'gpui-kit';
import type { Status } from './service.ts';

export const ONLINE: Color = '#3fbf6f';
export const AMBER: Color = '#e8b04b';

/** Each status as text and dot; null for the dimmed foreground */
export const STATUS: Record<Status, [string, Color | null]> = {
  connected: ['Connected', ONLINE],
  connecting: ['Connecting…', AMBER],
  unreachable: ['Unreachable', '#ff6467'],
  'auth-failed': ['Authentication failed', '#ff6467'],
  unconfigured: ['Not configured', null]
};

export function dot(color: Color) {
  return div().flex_none().size_2().rounded_full().bg(color);
}

/** `color` at `alpha`, for the tinted surfaces the theme has no token for */
export function tint(color: Color, alpha: number): Color {
  return `${color.slice(0, 7)}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}` as Color;
}
