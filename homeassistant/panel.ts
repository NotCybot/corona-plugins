import { View, div } from "gpui-kit";
import type { AsyncContext, Color, Context, Element } from "gpui-kit";
import type { Props } from "gpui-shell";
import type { Theme } from "gpui-base";
import {
  Slider,
  SliderIndicator,
  SliderState,
  SliderThumb,
  SliderTrack,
  h_flex,
  v_flex,
} from "gpui-base";
import type { SliderValue } from "gpui-base";
import {
  Button,
  Icon,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputState,
  Switch,
} from "gpui-component";
import type { ButtonElement } from "gpui-component";
import { call, getState } from "corona/plugin";
import type { JsonValue } from "corona/plugin";
import { get } from "corona/settings";
import { closePanel } from "corona/surface";
import type { Entity, Listed, Snapshot, Status } from "./service.ts";
import { AMBER, STATUS, dot, tint } from "./ui.ts";

const SECTIONS: [string, string[]][] = [
  ["Lights", ["light"]],
  ["Switches & locks", ["switch", "input_boolean", "fan", "cover", "lock"]],
  ["Sensors", ["sensor", "binary_sensor", "weather", "number", "climate", "media_player"]],
  ["Buttons", ["button", "input_button"]],
  ["Automations", ["automation", "script"]],
];
const TOGGLES = ["light", "switch", "input_boolean", "fan", "cover", "lock"];
/** One-shot entities: the button's label, icon and the service it calls in their domain */
const RUNS: Record<string, [string, string, string]> = {
  script: ["Run", "play", "turn_on"],
  automation: ["Trigger", "play", "trigger"],
  button: ["Press", "mouse-pointer-click", "press"],
  input_button: ["Press", "mouse-pointer-click", "press"],
};

const ICONS: Record<string, string> = {
  light: "lightbulb",
  switch: "power",
  input_boolean: "power",
  fan: "fan",
  lock: "lock",
  cover: "door-open",
  binary_sensor: "activity",
  automation: "bot",
  button: "circle-dot",
  input_button: "circle-dot",
  script: "play",
  climate: "thermometer",
  media_player: "tv",
  weather: "cloud",
};

/** What a binary sensor's on and off mean, by device class */
const BINARY: Record<string, [string, string]> = {
  door: ["Open", "Closed"],
  window: ["Open", "Closed"],
  opening: ["Open", "Closed"],
  garage_door: ["Open", "Closed"],
  motion: ["Detected", "Clear"],
  occupancy: ["Detected", "Clear"],
  presence: ["Home", "Away"],
  moisture: ["Wet", "Dry"],
  smoke: ["Detected", "Clear"],
  lock: ["Unlocked", "Locked"],
  plug: ["Plugged in", "Unplugged"],
  connectivity: ["Connected", "Disconnected"],
};

const COLOR_MODES = ["hs", "xy", "rgb", "rgbw", "rgbww"];
/**
 * Color temperature runs in 50 K steps: corona applies a slider's `min`
 * against the default `max` of 100 first, and a `min` above it panics.
 */
const KELVIN_STEP = 50;
/** The most Manage entities draws; the search narrows the rest */
const BROWSE_LIMIT = 100;

/** A light's sliders while its row is open, and whether they moved since */
type Draft = {
  id: string;
  bri: SliderState | null;
  ct: SliderState | null;
  hue: SliderState | null;
  dirty: boolean;
};

/** The pinned entities from the service, their controls, and Manage entities. */
export default class Panel extends View {
  declare browsing: boolean;
  declare all: Listed[] | null;
  declare query: string;
  declare search: InputState;
  declare draft: Draft | null;
  declare busy: Set<string>;

  init(_props: Props | undefined, _cx: AsyncContext): void {
    this.browsing = false;
    this.all = null;
    this.query = "";
    this.search = InputState("Search by name or entity id");
    this.draft = null;
    this.busy = new Set();
  }

  render(cx: Context): Element {
    const theme = cx.theme();
    const snap = (getState("ha") as Snapshot | null) ?? { status: "connecting" as Status, error: null, entities: {} };
    const root = v_flex().size_full().p_4().gap_3().child(this.header(snap, theme));
    if (this.browsing) {
      root.children(this.browser(theme));
    } else if (snap.status !== "connected") {
      root.child(message(snap, theme));
    } else {
      root.child(this.list(snap, theme));
    }
    const status = getState("msg") as string | null;
    if (status) {
      root.child(
        div()
          .flex_none()
          .px_0p5()
          .text_xs()
          .font_family(theme.typography.mono)
          .text_color(theme.muted_foreground)
          .child(status),
      );
    }
    return root;
  }

  header(snap: Snapshot, theme: Theme): Element {
    const [text, color] = STATUS[snap.status];
    const pinned = get("entities").length;
    const row = h_flex().flex_none().items_center().gap_2p5().px_0p5();
    if (this.browsing) {
      row.child(
        iconButton("ha-back", "icons/chevron-left.svg", "Back")
          .ghost()
          .on_click((_e, cx) => {
            this.browsing = false;
            cx.notify();
          }),
      );
    } else {
      row.child(new Icon("icons/house.svg").text_color(theme.foreground));
    }
    row.child(
      v_flex()
        .flex_1()
        .min_w_0()
        .child(div().text_lg().font_semibold().child(this.browsing ? "Manage entities" : "Home Assistant"))
        .child(
          h_flex()
            .items_center()
            .gap_1p5()
            .text_xs()
            .text_color(theme.muted_foreground)
            .child(dot(color ?? tint(theme.foreground, 0.3)))
            .child(text)
            .child(this.browsing ? div() : div().opacity(0.5).child("·"))
            .child(this.browsing ? div() : div().child(`${pinned} monitored`)),
        ),
    );
    if (!this.browsing) {
      row.child(
        headerButton("ha-manage", "icons/list-plus.svg", "Manage entities")
          .outline()
          .disabled(snap.status !== "connected")
          .loading(this.busy.has("browse"))
          .on_click((_e, cx) => this.browse(cx)),
      );
    }
    return row.child(
      headerButton("ha-close", "icons/x.svg", "Close")
        .outline()
        .on_click(() => closePanel("main")),
    );
  }

  list(snap: Snapshot, theme: Theme): Element {
    const pinned = get("entities").filter((id) => snap.entities[id]);
    const sections = SECTIONS.map(([title, domains]) => {
      const rows = pinned.filter((id) => domains.includes(domain(id))).map((id) => this.row(snap.entities[id], theme));
      return rows.length ? section(theme, title, group(theme, rows), div().font_normal().child(String(rows.length))) : null;
    }).filter((s): s is Element => s !== null);
    // pinned ids of a domain no section takes still show, under Other
    const known = SECTIONS.flatMap(([, domains]) => domains);
    const other = pinned.filter((id) => !known.includes(domain(id))).map((id) => this.row(snap.entities[id], theme));
    if (other.length) sections.push(section(theme, "Other", group(theme, other), div().font_normal().child(String(other.length))));
    return v_flex()
      .id("ha-list")
      .flex_1()
      .min_h_0()
      .overflow_y_scroll()
      .gap_4()
      .children(sections)
      .child(
        sections.length
          ? div()
          : div()
              .py_6()
              .text_center()
              .text_sm()
              .text_color(theme.muted_foreground)
              .child("No entities monitored. Use Manage entities to pin some."),
      );
  }

  row(e: Entity, theme: Theme): Element {
    const kind = domain(e.id);
    const name = String(e.attributes.friendly_name ?? e.id);
    // `unknown` is a button never pressed, still pressable
    const unavailable = e.state === "unavailable";
    const on = isOn(e);
    const open = this.draft?.id === e.id;
    const caps = kind === "light" ? lightCaps(e) : null;
    const iconColor: Color =
      kind === "light" && on ? AMBER : TOGGLES.includes(kind) && on ? theme.foreground : theme.muted_foreground;

    const main = h_flex()
      .items_center()
      .gap_2p5()
      .child(tile(theme, `icons/${icon(e)}.svg`, iconColor))
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .child(div().text_sm().font_medium().truncate().child(name))
          .child(div().text_xs().truncate().text_color(theme.muted_foreground).child(label(e))),
      );
    if (TOGGLES.includes(kind)) {
      if (caps && (caps.bri || caps.ct || caps.hue)) {
        main.child(
          iconButton(`ha-expand-${e.id}`, open ? "icons/chevron-up.svg" : "icons/chevron-down.svg", `${open ? "Collapse" : "Expand"} ${name}`)
            .ghost()
            .disabled(unavailable)
            .on_click((_e, cx) => this.expand(e, cx)),
        );
      }
      main.child(
        new Switch(`ha-toggle-${e.id}`)
          .checked(on)
          .disabled(unavailable || this.busy.has(e.id))
          .on_change((value, cx) => this.toggle(e, value, cx)),
      );
    } else if (Object.hasOwn(RUNS, kind)) {
      const [text, glyph, service] = RUNS[kind];
      main.child(
        new Button(`ha-run-${e.id}`)
          .cursor_pointer()
          .outline()
          .size("small")
          .disabled(unavailable)
          .loading(this.busy.has(e.id))
          .child(
            h_flex()
              .items_center()
              .gap_1p5()
              .child(new Icon(`icons/${glyph}.svg`).size("small"))
              .child(text),
          )
          .on_click((_e, cx) => this.service(e.id, kind, service, null, cx)),
      );
    } else {
      main.child(div().flex_none().text_sm().font_family(theme.typography.mono).child(value(e)));
    }
    if (!open || !this.draft) return main;

    const d = this.draft;
    const sliders: Element[] = [];
    const sliderRow = (title: string, state: SliderState, text: string) =>
      h_flex()
        .items_center()
        .gap_2()
        .text_xs()
        .text_color(theme.muted_foreground)
        .child(div().w(70).flex_none().font_semibold().child(title))
        .child(slider(state, theme))
        .child(div().w_10().flex_none().text_right().text_color(theme.foreground).child(text));
    if (d.bri) sliders.push(sliderRow("Brightness", d.bri, `${Math.round((single(d.bri.value()) / 255) * 100)}%`));
    if (d.ct) sliders.push(sliderRow("Color temp", d.ct, `${single(d.ct.value()) * KELVIN_STEP}K`));
    if (d.hue) sliders.push(sliderRow("Hue", d.hue, `${single(d.hue.value())}°`));
    return v_flex()
      .gap_2p5()
      .child(main)
      .child(
        v_flex()
          .gap_2()
          .pl(42)
          .children(sliders)
          .child(
            h_flex()
              .justify_end()
              .child(
                new Button(`ha-apply-${e.id}`)
                  .cursor_pointer()
                  .primary()
                  .size("small")
                  .disabled(!d.dirty)
                  .loading(this.busy.has(e.id))
                  .child(h_flex().items_center().gap_1p5().child(new Icon("icons/check.svg").size("small")).child("Apply"))
                  .on_click((_e, cx) => this.apply(e, cx)),
              ),
          ),
      );
  }

  browser(theme: Theme): Element[] {
    const all = this.all ?? [];
    const pinned = new Set(get("entities"));
    const query = this.query.trim().toLowerCase();
    const matches = all.filter((e) => !query || e.id.toLowerCase().includes(query) || e.name.toLowerCase().includes(query));
    const shown = matches.slice(0, BROWSE_LIMIT);
    const rows: Element[] = shown.map((e) => {
      const on = pinned.has(e.id);
      const button = iconButton(`ha-pin-${e.id}`, on ? "icons/pin-off.svg" : "icons/pin.svg", `${on ? "Unpin" : "Pin"} ${e.name}`)
        .loading(this.busy.has(`pin:${e.id}`))
        .on_click((_e, cx) => this.run("pin", { id: e.id, on: !on }, cx, `pin:${e.id}`));
      return h_flex()
        .items_center()
        .gap_2p5()
        .child(
          v_flex()
            .flex_1()
            .min_w_0()
            .child(div().text_sm().font_medium().truncate().child(e.name))
            .child(div().text_xs().truncate().font_family(theme.typography.mono).text_color(theme.muted_foreground).child(e.id)),
        )
        .child(on ? button.secondary() : button.ghost());
    });
    if (rows.length === 0) {
      rows.push(h_flex().justify_center().text_xs().text_color(theme.muted_foreground).child("No entities match."));
    }
    const more = matches.length > shown.length ? ` · showing ${shown.length}, search to narrow` : "";
    return [
      new InputGroup("ha-search")
        .flex_none()
        .addon(new InputGroupAddon("ha-search-icon").child(new Icon("icons/search.svg").size("small")))
        .input(
          new InputGroupInput(this.search).aria_label("Search entities").on_change((value, cx) => {
            this.query = value;
            cx.notify();
          }),
        ),
      v_flex()
        .id("ha-browser")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .gap_2()
        .child(
          div()
            .px_0p5()
            .text_xs()
            .font_semibold()
            .text_color(theme.muted_foreground)
            .child(`${matches.length} OF ${all.length} ENTITIES${more.toUpperCase()}`),
        )
        .child(group(theme, rows)),
    ];
  }

  /** Opens Manage entities with every entity, fetched once per opening */
  browse(cx: Context): void {
    if (this.busy.has("browse")) return;
    this.busy.add("browse");
    cx.notify();
    cx.spawn(async (cx) => {
      const answer = await call("browse");
      this.busy.delete("browse");
      if (Array.isArray(answer)) {
        this.all = answer as Listed[];
        this.browsing = true;
      }
      cx.notify();
    });
  }

  /** Opens a light's sliders at its current values, or closes them */
  expand(e: Entity, cx: Context): void {
    if (this.draft?.id === e.id) {
      for (const state of [this.draft.bri, this.draft.ct, this.draft.hue]) state?.release();
      this.draft = null;
      cx.notify();
      return;
    }
    for (const state of [this.draft?.bri, this.draft?.ct, this.draft?.hue]) state?.release();
    const caps = lightCaps(e);
    const a = e.attributes;
    const draft: Draft = { id: e.id, bri: null, ct: null, hue: null, dirty: false };
    const touched = (_value: SliderValue, cx: Context) => {
      draft.dirty = true;
      cx.notify();
    };
    const make = (options: { min: number; max: number; value: number }) => {
      const state = SliderState.new({ ...options, value: Math.min(options.max, Math.max(options.min, options.value)) });
      state.on("change", touched);
      return state;
    };
    if (caps.bri) draft.bri = make({ min: 1, max: 255, value: Number(a.brightness ?? 255) });
    if (caps.ct) {
      const min = Math.ceil(Number(a.min_color_temp_kelvin ?? 2000) / KELVIN_STEP);
      const max = Math.floor(Number(a.max_color_temp_kelvin ?? 6500) / KELVIN_STEP);
      draft.ct = make({ min, max, value: Math.round(Number(a.color_temp_kelvin ?? 3000) / KELVIN_STEP) });
    }
    if (caps.hue) draft.hue = make({ min: 0, max: 360, value: Math.round(Number((a.hs_color as number[] | null)?.[0] ?? 0)) });
    this.draft = draft;
    cx.notify();
  }

  /** Turns the light on at the sliders' values */
  apply(e: Entity, cx: Context): void {
    const d = this.draft;
    if (!d) return;
    const data: { [key: string]: JsonValue } = {};
    if (d.bri) data.brightness = single(d.bri.value());
    // color temperature and hue are two color modes; the one last moved wins only if both were touched, so hue goes last
    if (d.ct) data.color_temp_kelvin = single(d.ct.value()) * KELVIN_STEP;
    if (d.hue && Number((e.attributes.hs_color as number[] | null)?.[0] ?? -1) !== single(d.hue.value())) {
      delete data.color_temp_kelvin;
      data.hs_color = [single(d.hue.value()), Number((e.attributes.hs_color as number[] | null)?.[1] ?? 100)];
    }
    d.dirty = false;
    this.service(e.id, "light", "turn_on", data, cx);
  }

  toggle(e: Entity, on: boolean, cx: Context): void {
    const kind = domain(e.id);
    const [service, serviceDomain] =
      kind === "lock"
        ? [on ? "lock" : "unlock", "lock"]
        : kind === "cover"
          ? [on ? "open_cover" : "close_cover", "cover"]
          : [on ? "turn_on" : "turn_off", "homeassistant"];
    this.service(e.id, serviceDomain, service, null, cx);
  }

  service(entity: string, domain: string, service: string, data: JsonValue, cx: Context): void {
    this.run("call", { domain, service, entity, data }, cx, entity);
  }

  /** Calls the service; errors come back through state `msg` */
  run(method: string, args: JsonValue, cx: Context, key = method): void {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      await call(method, args);
      this.busy.delete(key);
      cx.notify();
    });
  }
}

function domain(id: string): string {
  return id.split(".")[0];
}

function isOn(e: Entity): boolean {
  return ["on", "open", "opening", "locked", "playing", "home"].includes(e.state);
}

function lightCaps(e: Entity): { bri: boolean; ct: boolean; hue: boolean } {
  const modes = (e.attributes.supported_color_modes as string[] | null) ?? [];
  return {
    bri: modes.some((m) => m !== "onoff"),
    ct: modes.includes("color_temp"),
    hue: modes.some((m) => COLOR_MODES.includes(m)),
  };
}

function icon(e: Entity): string {
  const kind = domain(e.id);
  if (kind === "sensor") {
    const cls = String(e.attributes.device_class ?? "");
    if (cls === "humidity") return "droplet";
    if (["power", "energy", "current", "voltage"].includes(cls)) return "zap";
    if (cls === "temperature") return "thermometer";
    return "activity";
  }
  if (kind === "lock" && e.state !== "locked") return "lock-open";
  if (kind === "cover" && e.state === "closed") return "door-closed";
  return ICONS[kind] ?? "house";
}

/** The line under the name */
function label(e: Entity): string {
  const kind = domain(e.id);
  if (e.state === "unavailable") return "Unavailable";
  if (kind === "light") {
    const bri = e.attributes.brightness;
    return isOn(e) ? (typeof bri === "number" ? `On · ${Math.round((bri / 255) * 100)}%` : "On") : "Off";
  }
  if (kind === "lock") return e.state === "locked" ? "Locked" : e.state === "unlocked" ? "Unlocked" : capital(e.state);
  if (kind === "cover") return capital(e.state);
  if (kind === "automation") {
    const last = e.attributes.last_triggered;
    return typeof last === "string" ? `Last run ${when(last)}` : e.state === "off" ? "Disabled" : "Never run";
  }
  if (kind === "script") return e.state === "on" ? "Running" : "Idle";
  // a button's state is when it was last pressed
  if (kind === "button" || kind === "input_button") {
    return Number.isNaN(Date.parse(e.state)) ? "Never pressed" : `Last pressed ${when(e.state)}`;
  }
  if (kind === "sensor") return capital(String(e.attributes.device_class ?? "sensor").replace(/_/g, " "));
  if (kind === "binary_sensor") return "Binary sensor";
  if (TOGGLES.includes(kind)) return isOn(e) ? "On" : "Off";
  return capital(kind.replace(/_/g, " "));
}

/** The value at the right of a sensor-like row */
function value(e: Entity): string {
  const kind = domain(e.id);
  if (e.state === "unavailable" || e.state === "unknown") return "–";
  if (kind === "binary_sensor") {
    const [on, off] = BINARY[String(e.attributes.device_class ?? "")] ?? ["On", "Off"];
    return e.state === "on" ? on : off;
  }
  if (kind === "climate") {
    const target = e.attributes.temperature;
    return `${capital(e.state)}${typeof target === "number" ? ` · ${target} °C` : ""}`;
  }
  const unit = e.attributes.unit_of_measurement;
  return unit ? `${e.state} ${unit}` : capital(e.state.replace(/_/g, " "));
}

function when(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  return days === 0 ? `today ${time}` : days === 1 ? `yesterday ${time}` : `${date.toLocaleDateString()} ${time}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The centered state for every status but connected */
function message(snap: Snapshot, theme: Theme): Element {
  const texts: Record<Exclude<Status, "connected">, [string, string, string, boolean]> = {
    connecting: ["settings", "Connecting to Home Assistant…", "Waiting for the live connection to come up.", false],
    unreachable: [
      "wifi-off",
      "Home Assistant is unreachable",
      `${snap.error ? `${snap.error}. ` : ""}Check the URL in the plugin settings and that the server is online. Retrying automatically.`,
      true,
    ],
    "auth-failed": [
      "key",
      "Authentication failed",
      "Create a new long-lived access token in Home Assistant (Profile → Security) and paste it into the plugin settings.",
      true,
    ],
    unconfigured: ["settings", "Set up Home Assistant", "Add your Home Assistant URL and a long-lived access token in the plugin settings.", false],
  };
  const [iconName, title, body, bad] = texts[snap.status as Exclude<Status, "connected">];
  return v_flex()
    .flex_1()
    .items_center()
    .justify_center()
    .gap_2p5()
    .px_8()
    .text_center()
    .child(
      div()
        .size_11()
        .flex()
        .items_center()
        .justify_center()
        .rounded_lg()
        .bg(theme.muted)
        .child(new Icon(`icons/${iconName}.svg`).text_color(bad ? theme.destructive : theme.muted_foreground)),
    )
    .child(div().text_sm().font_medium().child(title))
    .child(div().text_xs().text_color(theme.muted_foreground).child(body));
}

/** A titled block: the uppercase label, something at its right, the content */
function section(theme: Theme, title: string, content: Element, right: Element): Element {
  return v_flex()
    .flex_none()
    .gap_2()
    .child(
      h_flex()
        .items_center()
        .justify_between()
        .min_h_6()
        .px_0p5()
        .text_xs()
        .font_semibold()
        .text_color(theme.muted_foreground)
        .child(title.toUpperCase())
        .child(right),
    )
    .child(content);
}

/** Rows in corona's `card()`, divided by its border */
function group(theme: Theme, rows: Element[]): Element {
  return v_flex()
    .flex_none()
    .rounded_xl()
    .border_1()
    .border_color(theme.border)
    .bg(theme.accent)
    .overflow_hidden()
    .children(
      rows.map((row, i) => {
        const cell = div().px_3().py_2p5().child(row);
        return i ? cell.border_t_1().border_color(theme.border) : cell;
      }),
    );
}

/** The 32 px icon square in front of a row */
function tile(theme: Theme, path: string, color: Color): Element {
  return div()
    .flex_none()
    .size_8()
    .flex()
    .items_center()
    .justify_center()
    .rounded_lg()
    .bg(theme.muted)
    .child(new Icon(path).size("small").text_color(color));
}

/** gpui-component's slider look: a 6 px groove, the primary fill, a ringed 16 px thumb */
function slider(state: SliderState, theme: Theme): Element {
  // px_2 like corona's dashboard sliders: the thumb overhangs the track by half its width
  return Slider.new(state)
    .flex_1()
    .px_2()
    .child(
      SliderTrack.new(state)
        .flex()
        .items_center()
        .h_6()
        .w_full()
        .cursor_pointer()
        .child(
          SliderIndicator.new(state)
            .relative()
            .w_full()
            .h_1p5()
            .rounded_full()
            .bg(tint(theme.primary, 0.2))
            .range_style((fill) => fill.rounded_full().bg(theme.primary))
            .child(
              SliderThumb.new(state)
                .size_4()
                .ml(-8)
                .top(-5)
                .p(1)
                .rounded_full()
                .bg(tint(theme.primary, 0.5))
                .child(div().size_full().rounded_full().bg(theme.primary_foreground)),
            ),
        ),
    );
}

function headerButton(id: string, icon: string, label: string): ButtonElement {
  return new Button(id)
    .cursor_pointer()
    .size_8()
    .p_0()
    .tooltip(label)
    .child(new Icon(icon).size("small"));
}

function iconButton(id: string, icon: string, label: string): ButtonElement {
  // square, like the design's icon-sm: 28 px without padding
  return new Button(id)
    .cursor_pointer()
    .size("small")
    .size_7()
    .p_0()
    .tooltip(label)
    .child(new Icon(icon).size("small"));
}

function single(value: SliderValue): number {
  return Array.isArray(value) ? value[1] : value;
}
