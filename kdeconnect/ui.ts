import { div } from "gpui-kit";
import type { Color } from "gpui-kit";

export const ONLINE: Color = "#3fbf6f";

export const DEVICE_ICON: Record<string, string> = {
  phone: "icons/smartphone.svg",
  smartphone: "icons/smartphone.svg",
  tablet: "icons/tablet.svg",
};

export function dot(color: Color) {
  return div().flex_none().size_2().rounded_full().bg(color);
}

/** `color` at `alpha`, for the tinted surfaces the theme has no token for */
export function tint(color: Color, alpha: number): Color {
  return `${color.slice(0, 7)}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}` as Color;
}
