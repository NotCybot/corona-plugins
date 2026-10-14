import { View, div } from 'gpui-kit';
import type { Context, Element } from 'gpui-kit';
import { getState } from 'corona/plugin';
import { bar, togglePanel } from 'corona/surface';
import type { Snapshot } from './service.ts';
import { CONN_TEXT, logo } from './ui.ts';

/** Tailscale's mark, dimmed unless connected; opens and closes the panel. */
export default class Widget extends View {
  render(cx: Context): Element {
    const theme = cx.theme();
    const conn = (getState('ts') as Snapshot | null)?.conn ?? 'starting';
    // like corona's own bar buttons: a 16 px icon in a round 24 px button,
    // secondary, ghost without a pill of its own, danger when it needs you.
    // A div: the runtime refuses `rounded_full` on a component Button.
    const fill =
      conn === 'needs-login'
        ? theme.destructive
        : bar()?.bare
          ? null
          : theme.secondary;
    const button = div()
      .id('tailscale-toggle')
      .flex_none()
      .p(4)
      .rounded_full()
      .cursor_pointer()
      .tooltip(`Tailscale: ${CONN_TEXT[conn]}`)
      .hover((el) => el.bg(theme.accent))
      .on_click(() => {
        const error = togglePanel('main');
        if (error) console.error(error.message);
      })
      .child(
        logo(
          conn === 'running' ? theme.foreground : theme.muted_foreground,
          true
        )
      );
    return fill ? button.bg(fill) : button;
  }
}
