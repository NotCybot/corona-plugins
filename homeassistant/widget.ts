import { View, div } from 'gpui-kit';
import type { Context, Element } from 'gpui-kit';
import { Icon } from 'gpui-component';
import { getState } from 'corona/plugin';
import { bar, togglePanel } from 'corona/surface';
import type { Snapshot } from './service.ts';
import { STATUS } from './ui.ts';

/** A house, dimmed unless connected; opens and closes the panel. */
export default class Widget extends View {
  render(cx: Context): Element {
    const theme = cx.theme();
    const status = (getState('ha') as Snapshot | null)?.status ?? 'connecting';
    // Like corona's own bar buttons: a 16 px icon in a round 24 px button,
    // Secondary, ghost without a pill of its own, danger when it needs you.
    // A div: the runtime refuses `rounded_full` on a component Button.
    const fill =
      status === 'auth-failed'
        ? theme.destructive
        : bar()?.bare
          ? null
          : theme.secondary;
    const button = div()
      .id('homeassistant-toggle')
      .flex_none()
      .p(4)
      .rounded_full()
      .cursor_pointer()
      .tooltip(`Home Assistant: ${STATUS[status][0]}`)
      .hover((el) => el.bg(theme.accent))
      .on_click(() => {
        const error = togglePanel('main');
        if (error) {
          console.error(error.message);
        }
      })
      .child(
        new Icon('icons/house.svg')
          .size('small')
          .text_color(
            status === 'connected' ? theme.foreground : theme.muted_foreground
          )
      );
    return fill ? button.bg(fill) : button;
  }
}
