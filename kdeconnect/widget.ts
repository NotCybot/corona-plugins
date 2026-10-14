import { type Context, type Element, View, div } from 'gpui-kit';
import { Icon } from 'gpui-component';
import { bar, togglePanel } from 'corona/surface';
import { snapshot } from './state.ts';

/** A phone, dimmed unless one is connected; opens and closes the panel. */
export default class Widget extends View {
  public render(cx: Context): Element {
    const theme = cx.theme();
    const devices = snapshot()?.devices ?? [];
    const connected = devices.find((d) => d.paired && d.reachable);
    const asking = devices.some((d) => d.pairRequestedByPeer);
    // Like corona's own bar buttons: a 16 px icon in a round 24 px button,
    // Secondary, ghost without a pill of its own, danger when it needs you.
    // A div: the runtime refuses `rounded_full` on a component Button.
    const fill = asking
      ? theme.destructive
      : bar()?.bare
        ? null
        : theme.secondary;
    const battery = connected?.battery ? ` · ${connected.battery.charge}%` : '';
    const button = div()
      .id('kdeconnect-toggle')
      .flex_none()
      .p(4)
      .rounded_full()
      .cursor_pointer()
      .tooltip(
        connected
          ? `${connected.name}${battery}`
          : asking
            ? 'A device asks to pair'
            : 'No phone connected'
      )
      .hover((el) => el.bg(theme.accent))
      .on_click(() => {
        const error = togglePanel('main');
        if (error) {
          console.error(error.message);
        }
      })
      .child(
        new Icon('icons/smartphone.svg')
          .size('small')
          .text_color(connected ? theme.foreground : theme.muted_foreground)
      );
    return fill ? button.bg(fill) : button;
  }
}
