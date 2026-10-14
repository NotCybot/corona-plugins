import { View } from 'gpui-kit';
import type { Context, Element } from 'gpui-kit';
import { Button } from 'gpui-component';
import { getState } from 'corona/plugin';
import { t } from 'corona/i18n';
import { isPanelOpen, togglePanel } from 'corona/surface';

/** A bar button with the service's heartbeat; opens and closes the panel. */
export default class Widget extends View {
  render(_cx: Context): Element {
    const label = t('widget.label', { count: getState('heartbeat') ?? '–' });
    const button = new Button('demo-toggle').label(label).size('small');
    // Stands out while its panel is open
    return (
      isPanelOpen('main') === true ? button.primary() : button.ghost()
    ).on_click(() => {
      const error = togglePanel('main');
      if (error) {
        console.error(error.message);
      }
    });
  }
}
