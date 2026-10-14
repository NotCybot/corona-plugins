import { type Color, type Element, div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import type { Conn } from './service.ts';

export const ONLINE: Color = '#3fbf6f';

/** Tailscale's mark: a 3×3 grid of dots, the bottom-left "T" lit */
const MARK = [0.4, 0.4, 0.4, 1, 1, 1, 0.4, 1, 0.4];

/** 20 px, or 16 px `small` for the bar like corona's widget icons */
export function logo(color: Color, small = false): Element {
  const gap = small ? 2 : 4;
  const rows = [0, 3, 6].map((start) =>
    h_flex()
      .gap(gap)
      .children(
        MARK.slice(start, start + 3).map((opacity) =>
          dot(color).size_1().opacity(opacity)
        )
      )
  );
  return v_flex().flex_none().gap(gap).children(rows);
}

export function dot(color: Color) {
  return div().flex_none().size_2().rounded_full().bg(color);
}

/** `color` at `alpha`, for the tinted surfaces the theme has no token for */
export function tint(color: Color, alpha: number): Color {
  return `#${color.slice(1, 7)}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

/** The label of a `Select` row, which the runtime hands back untyped */
export function label(row: unknown): string {
  return typeof row === 'object' && row !== null && 'label' in row
    ? String(row.label)
    : '';
}

export const CONN_TEXT: Record<Conn, string> = {
  'needs-login': 'Needs login',
  running: 'Connected',
  starting: 'Starting…',
  stopped: 'Stopped',
  unavailable: 'Not running'
};
