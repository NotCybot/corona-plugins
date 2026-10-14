import { View } from 'gpui-kit';
import { Button } from 'gpui-component';
import { get } from 'corona/settings';
import { togglePanel, isPanelOpen } from 'corona/surface';

/** @import { AsyncContext, Context, Element } from "gpui-kit" */
/** @import { Props } from "gpui-shell" */

/** A bar button that opens and closes the plugin's panel. */
export default class Widget extends View {
  /** @param {Props | undefined} _props @param {AsyncContext} _cx */
  init(_props, _cx) {}

  /** @param {Context} _cx @returns {Element} */
  render(_cx) {
    const button = new Button('test-toggle').label(get('label')).size('small');
    // stands out while its panel is open
    return (isPanelOpen('main') ? button.primary() : button.ghost()).on_click(
      () => {
        const error = togglePanel('main');
        if (error) console.error(error.message);
      }
    );
  }
}
