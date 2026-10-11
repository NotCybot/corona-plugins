import { View } from "gpui-kit";
import { v_flex } from "gpui-base";
import { Button } from "gpui-component";
import { get } from "corona/settings";
import { closePanel } from "corona/surface";

/** @import { AsyncContext, Context, Element } from "gpui-kit" */
/** @import { Props } from "gpui-shell" */

/** The panel the widget toggles. */
export default class Panel extends View {
  /** @param {Props | undefined} _props @param {AsyncContext} _cx */
  init(_props, _cx) {}

  /** @param {Context} _cx @returns {Element} */
  render(_cx) {
    return v_flex()
      .size_full()
      .gap_2()
      .p_4()
      .child(get("label"))
      .child("Opened from the bar widget; Click it again to close. Test")
      .child(new Button("test-close").label("Close").on_click(() => closePanel("main")));
  }
}
