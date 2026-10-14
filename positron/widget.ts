import { type Context, type Element, View, div } from 'gpui-kit';
import { Icon } from 'gpui-component';
import { call } from 'corona/plugin';
import { bar } from 'corona/surface';

/** A notes icon that opens and closes positron's notes window. */
export default class Widget extends View {
  public render(cx: Context): Element {
    const theme = cx.theme();
    // Like corona's own bar buttons: a 16 px icon in a round 24 px button,
    // Secondary, ghost without a pill of its own.
    // A div: the runtime refuses `rounded_full` on a component Button.
    const button = div()
      .id('positron-notes-toggle')
      .flex_none()
      .p(4)
      .rounded_full()
      .cursor_pointer()
      .tooltip('Notes')
      .hover((el) => el.bg(theme.accent))
      // Positron closes its window on a click outside of it, so this toggles
      // From the bar, which its backdrop leaves clickable
      .on_click((_e, cx) => cx.spawn(async () => call('toggle')))
      .child(
        new Icon('icons/notebook-pen.svg')
          .size('small')
          .text_color(theme.foreground)
      );
    return bar()?.bare ? button : button.bg(theme.secondary);
  }
}
