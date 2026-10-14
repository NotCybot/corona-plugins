import { View, div } from 'gpui-kit';
import type { AsyncContext, Context, Element, NativeElement } from 'gpui-kit';
import type { Props } from 'gpui-shell';
import type { Theme } from 'gpui-base';
import {
  Slider,
  SliderIndicator,
  SliderState,
  SliderThumb,
  SliderTrack,
  h_flex,
  v_flex
} from 'gpui-base';
import type { SliderValue } from 'gpui-base';
import {
  Button,
  Icon,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputState,
  Select,
  Switch,
  Tab,
  TabBar
} from 'gpui-component';
import type { ButtonElement, InputGroupElement } from 'gpui-component';
import { call, getState } from 'corona/plugin';
import type { JsonValue } from 'corona/plugin';
import { closePanel } from 'corona/surface';
import type { Cast, CastOptions, Device, Snapshot } from './service.ts';
import { DEVICE_ICON, ONLINE, dot, tint } from './ui.ts';

const TABS = ['Controls', 'Cast', 'Messages', 'Devices'];

const PRESETS: { label: string; res: number; br: number; fps: number }[] = [
  { label: 'HD', res: 1920, br: 16, fps: 60 },
  { label: 'Balanced', res: 1280, br: 8, fps: 60 },
  { label: 'Saver', res: 1024, br: 4, fps: 30 }
];
const CUSTOM = PRESETS.length;

/**
 * The custom quality sliders: key, label, range in slider steps, what a step
 * is worth, and unit. Resolution counts in 64 px steps (256–3840): corona
 * applies a slider's `min` against the default `max` of 100 first, and a
 * `min` above it panics the whole shell.
 */
const QUALITY = [
  { key: 'res', short: 'RES', min: 4, max: 60, per: 64, unit: 'p' },
  { key: 'br', short: 'BIT', min: 1, max: 30, per: 1, unit: ' Mbps' },
  { key: 'fps', short: 'FPS', min: 1, max: 240, per: 1, unit: ' fps' }
] as const;

/** Seek runs in thousandths of the track, since a slider's range is fixed when it is made */
const SEEK_STEPS = 1000;

type Favorite = { number: string; name: string };

/** KDE Connect's devices from the service, and their actions as service calls. */
export default class Panel extends View {
  declare tab: number;
  declare selected: string | null;
  declare busy: Set<string>;
  declare favorites: Favorite[];
  declare editMode: boolean;
  /** The favorite being renamed, by number */
  declare editing: string | null;
  declare dest: string;
  declare text: string;
  declare destInput: InputState;
  declare textInput: InputState;
  declare nameInput: InputState;
  declare castOptions: CastOptions;
  declare preset: number;
  declare adbSetup: boolean;
  /** 0 pair, 1 connect */
  declare adbMode: number;
  declare pairPort: InputState;
  declare pairPin: InputState;
  declare connectAddress: InputState;
  declare volume: SliderState;
  declare seek: SliderState;
  declare quality: Record<(typeof QUALITY)[number]['key'], SliderState>;
  /** A slider being dragged is not moved by the state */
  declare dragging: SliderState | null;

  init(_props: Props | undefined, cx: AsyncContext): void {
    this.tab = 0;
    this.selected = null;
    this.busy = new Set();
    this.favorites = load('favorites', []);
    this.editMode = false;
    this.editing = null;
    this.dest = '';
    this.text = '';
    this.destInput = InputState('Number or contact name');
    this.textInput = InputState('Write a message');
    this.nameInput = InputState('Contact name');
    this.castOptions = load('cast', {
      ...PRESETS[0],
      record: false,
      screenOff: false
    });
    this.preset = presetOf(this.castOptions);
    this.adbSetup = false;
    this.adbMode = 0;
    this.pairPort = InputState('Pair port');
    this.pairPin = InputState('PIN');
    this.connectAddress = InputState('address:port');
    this.dragging = null;

    this.volume = this.slider({ min: 0, max: 100 }, (value) => {
      const device = this.device();
      if (device) this.run('volume', { id: device.id, value }, cx);
    });
    this.seek = this.slider({ min: 0, max: SEEK_STEPS }, (value) => {
      const media = this.device()?.media;
      if (media)
        this.run(
          'seek',
          { id: this.device().id, ms: (value / SEEK_STEPS) * media.length },
          cx
        );
    });
    this.quality = Object.fromEntries(
      QUALITY.map((q) => [
        q.key,
        this.slider(
          { min: q.min, max: q.max, value: this.castOptions[q.key] / q.per },
          () => store('cast', this.castOptions),
          (value, cx) => {
            this.castOptions = { ...this.castOptions, [q.key]: value * q.per };
            cx.notify();
          }
        )
      ])
    ) as Panel['quality'];

    cx.spawn(async (cx) => {
      // the signals keep the state current; this catches up on whatever was missed while closed
      await call('refresh');
      const device = this.device();
      if (device?.address)
        await call('adbStatus', { id: device.id, address: device.address });
      cx.notify();
    });
    // ponytail: KDE Connect reports the position only when it changes; while
    // playing, the seek bar moves on locally, once a second, and only then
    cx.timer.every(1000, (cx) => {
      const media = this.device()?.media;
      if (!media?.playing || this.dragging === this.seek) return;
      this.seek.set_value(
        Math.round((position(media) / Math.max(media.length, 1)) * SEEK_STEPS)
      );
      cx.notify();
    });
  }

  /** A slider whose `release` runs `commit`, and whose drag stops the state moving it */
  slider(
    options: { min: number; max: number; step?: number; value?: number },
    commit: (value: number) => void,
    change?: (value: number, cx: Context) => void
  ): SliderState {
    const state = SliderState.new(options);
    state.on('change', (value, cx) => {
      this.dragging = state;
      change?.(single(value), cx);
    });
    state.on('release', (value) => {
      this.dragging = null;
      commit(single(value));
    });
    return state;
  }

  /** The device the panel shows: the one picked, else the first reachable paired one */
  device(): Device | null {
    const paired = ((getState('kc') as Snapshot | null)?.devices ?? []).filter(
      (d) => d.paired
    );
    return (
      paired.find((d) => d.id === this.selected) ??
      paired.find((d) => d.reachable) ??
      paired[0] ??
      null
    );
  }

  render(cx: Context): Element {
    const theme = cx.theme();
    const snap = getState('kc') as Snapshot | null;
    const device = this.device();
    const nearby = (snap?.devices ?? []).filter(
      (d) => !d.paired && (d.reachable || d.pairRequestedByPeer)
    );
    const status = getState('msg') as string | null;

    const root = v_flex().size_full().p_2().gap_3().child(this.header(theme));
    if (!snap?.running) {
      root.child(empty(theme, 'KDE Connect is not running.'));
    } else if (!device && nearby.length === 0) {
      root.child(
        empty(theme, 'No devices found. Pair a phone in KDE Connect.')
      );
    } else if (!device) {
      root.child(scroll('kc-tab').children(this.devices(snap, theme)));
    } else {
      this.sync(device);
      const off = !device.reachable;
      root
        .child(this.picker(snap, device, theme))
        .child(
          new TabBar('kc-tabs')
            .flex_none()
            .self_start()
            .variant('segmented')
            .selected_index(this.tab)
            .on_change((index, cx) => {
              this.tab = index;
              cx.notify();
            })
            .children(
              TABS.map((label) => new Tab().cursor_pointer().label(label))
            )
        )
        .child(
          scroll('kc-tab')
            .gap_4()
            .opacity(off && this.tab !== 3 ? 0.55 : 1)
            .children(
              this.tab === 0
                ? this.controls(device, theme)
                : this.tab === 1
                  ? this.cast(device, theme)
                  : this.tab === 2
                    ? this.messages(device, theme)
                    : this.devices(snap, theme)
            )
        );
    }
    if (status) {
      root.child(
        div()
          .flex_none()
          .px_0p5()
          .text_xs()
          .font_family(theme.typography.mono)
          .text_color(theme.muted_foreground)
          .child(status)
      );
    }
    return root;
  }

  /** Moves the sliders to the device's values, unless one is being dragged */
  sync(device: Device): void {
    if (
      this.dragging !== this.volume &&
      device.volume !== null &&
      single(this.volume.value()) !== device.volume
    ) {
      this.volume.set_value(device.volume);
    }
    const media = device.media;
    if (this.dragging !== this.seek) {
      const value = media
        ? Math.round((position(media) / Math.max(media.length, 1)) * SEEK_STEPS)
        : 0;
      if (single(this.seek.value()) !== value) this.seek.set_value(value);
    }
  }

  header(theme: Theme): Element {
    return h_flex()
      .flex_none()
      .items_center()
      .gap_2p5()
      .px_0p5()
      .child(new Icon('icons/smartphone.svg').text_color(theme.foreground))
      .child(div().flex_1().text_lg().font_semibold().child('Phone'))
      .child(
        headerButton('kc-refresh', 'icons/refresh-cw.svg', 'Refresh')
          .outline()
          .loading(this.busy.has('refresh'))
          .on_click((_e, cx) => this.run('refresh', null, cx))
      )
      .child(
        headerButton('kc-close', 'icons/x.svg', 'Close')
          .outline()
          .on_click(() => closePanel('main'))
      );
  }

  /** The device select and its status line: reachability, battery, network, address */
  picker(snap: Snapshot, device: Device, theme: Theme): Element {
    const paired = snap.devices.filter((d) => d.paired);
    const info: Element[] = [
      h_flex()
        .items_center()
        .gap_1p5()
        .child(dot(device.reachable ? ONLINE : tint(theme.foreground, 0.3)))
        .child(device.reachable ? 'Connected' : 'Offline')
    ];
    if (device.battery) {
      const { charge, charging } = device.battery;
      const icon = charging
        ? 'battery-charging'
        : charge <= 20
          ? 'battery-low'
          : charge <= 60
            ? 'battery-medium'
            : 'battery-full';
      info.push(
        h_flex()
          .items_center()
          .gap_1()
          .child(
            new Icon(`icons/${icon}.svg`)
              .size('small')
              .text_color(
                charge <= 20 && !charging
                  ? theme.destructive
                  : theme.muted_foreground
              )
          )
          .child(`${charge}%`)
      );
    }
    if (device.network)
      info.push(
        div().child(
          `${device.network.type} ${Math.max(0, device.network.strength)}/4`
        )
      );
    if (device.reachable && device.address)
      info.push(div().font_family(theme.typography.mono).child(device.address));
    return v_flex()
      .flex_none()
      .gap_2()
      .child(
        // keyed by the device: a Select keeps its own choice, so a new one shows the current device
        new Select(
          `kc-device-${device.id}`,
          () =>
            paired.map((d) => ({
              id: d.id,
              label: `${d.name} · ${d.reachable ? 'Connected' : 'Offline'}`
            })),
          (row) => div().child((row as { label: string }).label),
          (id, cx) => this.select(id, cx)
        )
          .w_full()
          .placeholder(
            `${device.name} · ${device.reachable ? 'Connected' : 'Offline'}`
          )
      )
      .child(
        h_flex()
          .items_center()
          .gap_1p5()
          .px_0p5()
          .text_xs()
          .text_color(theme.muted_foreground)
          .children(
            info.flatMap((part, i) =>
              i ? [div().opacity(0.5).child('·'), part] : [part]
            )
          )
      );
  }

  select(id: string, cx: Context): void {
    this.selected = id;
    cx.notify();
    const device = this.device();
    if (device?.address)
      this.run('adbStatus', { id: device.id, address: device.address }, cx);
  }

  controls(device: Device, theme: Theme): Element[] {
    const off = !device.reachable;
    const id = device.id;
    const actions: [string, string, string][] = [
      ['ring', 'bell-ring', 'Ring'],
      ['ping', 'radio', 'Ping'],
      ['browse', 'folder-open', 'Browse'],
      ['clipboard', 'clipboard', 'Clipboard'],
      ['share', 'share-2', 'Share']
    ];
    const media = device.media;
    const noMedia = off || !media;
    const muted = (device.volume ?? 0) <= 0;
    const now = media ? position(media) : 0;
    return [
      section(
        theme,
        'Quick actions',
        h_flex()
          .gap_1p5()
          .children(
            actions.map(([method, icon, label]) =>
              new Button(`kc-${method}`)
                .cursor_pointer()
                .outline()
                .flex_1()
                .h(56)
                .disabled(off)
                .loading(this.busy.has(method))
                .on_click((_e, cx) => this.run(method, { id }, cx))
                .child(
                  v_flex()
                    .items_center()
                    .gap_1()
                    .child(new Icon(`icons/${icon}.svg`).size('small'))
                    .child(div().text_xs().child(label))
                )
            )
          )
      ),
      section(
        theme,
        'Sound & media',
        group(theme, [
          h_flex()
            .items_center()
            .gap_1()
            .child(
              (muted
                ? iconButton('kc-mute', 'icons/volume-x.svg', 'Unmute').danger()
                : iconButton('kc-mute', 'icons/volume-2.svg', 'Mute').ghost()
              )
                .disabled(off || device.volume === null)
                .on_click((_e, cx) => this.run('mute', { id }, cx))
            )
            .child(slider(this.volume, theme, off || device.volume === null))
            .child(
              div()
                .w_10()
                .flex_none()
                .text_right()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(
                  off || device.volume === null ? '–' : `${device.volume}%`
                )
            ),
          v_flex()
            .gap_2p5()
            .child(
              h_flex()
                .items_center()
                .gap_3()
                .child(
                  div()
                    .flex_none()
                    .size_11()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_lg()
                    .bg(theme.muted)
                    .child(
                      new Icon('icons/music.svg').text_color(
                        theme.muted_foreground
                      )
                    )
                )
                .child(
                  v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                      div()
                        .text_sm()
                        .font_medium()
                        .truncate()
                        .child(
                          media && !off
                            ? media.title || 'Unknown title'
                            : 'No media playing'
                        )
                    )
                    .child(
                      div()
                        .text_xs()
                        .truncate()
                        .text_color(theme.muted_foreground)
                        .child(media && !off ? media.artist : '')
                    )
                )
                .child(
                  h_flex()
                    .flex_none()
                    .gap_0p5()
                    .child(
                      iconButton('kc-prev', 'icons/skip-back.svg', 'Previous')
                        .ghost()
                        .disabled(noMedia)
                        .on_click((_e, cx) =>
                          this.run('media', { id, action: 'Previous' }, cx)
                        )
                    )
                    .child(
                      iconButton(
                        'kc-play',
                        media?.playing ? 'icons/pause.svg' : 'icons/play.svg',
                        media?.playing ? 'Pause' : 'Play'
                      )
                        .primary()
                        .disabled(noMedia)
                        .on_click((_e, cx) =>
                          this.run('media', { id, action: 'PlayPause' }, cx)
                        )
                    )
                    .child(
                      iconButton('kc-next', 'icons/skip-forward.svg', 'Next')
                        .ghost()
                        .disabled(noMedia)
                        .on_click((_e, cx) =>
                          this.run('media', { id, action: 'Next' }, cx)
                        )
                    )
                )
            )
            .child(
              h_flex()
                .items_center()
                .gap_2()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(
                  div()
                    .w_8()
                    .text_right()
                    .child(clock(noMedia ? 0 : now))
                )
                .child(slider(this.seek, theme, noMedia || !media.canSeek))
                .child(
                  div()
                    .w_8()
                    .child(clock(noMedia ? 0 : media.length))
                )
            )
        ])
      )
    ];
  }

  cast(device: Device, theme: Theme): Element[] {
    const off = !device.reachable;
    const id = device.id;
    const state = ((getState('cast') as Record<string, Cast> | null) ?? {})[
      id
    ] ?? {
      serial: null,
      casting: false
    };
    const connected = state.serial !== null;
    const connection: Element[] = [
      h_flex()
        .items_center()
        .gap_2p5()
        .child(tile(theme, 'icons/link.svg'))
        .child(
          text(
            theme,
            connected ? state.serial : 'Wireless debugging',
            connected ? 'Wi-Fi · ADB connected' : 'Not connected'
          )
        )
        .child(
          connected
            ? this.action('kc-adb-off', 'Disconnect', 'adbDisconnect', {
                id,
                serial: state.serial
              }).outline()
            : new Button('kc-adb-setup')
                .cursor_pointer()
                .outline()
                .size('small')
                .label(this.adbSetup ? 'Cancel' : 'Set up')
                .on_click((_e, cx) => {
                  this.adbSetup = !this.adbSetup;
                  cx.notify();
                })
        )
    ];
    if (!connected && this.adbSetup) {
      const host = device.address ?? '';
      connection.push(
        v_flex()
          .gap_2p5()
          .child(
            new TabBar('kc-adb-mode')
              .variant('segmented')
              .size('small')
              .self_start()
              .selected_index(this.adbMode)
              .on_change((index, cx) => {
                this.adbMode = index;
                cx.notify();
              })
              .children(
                ['Pair', 'Connect'].map((label) =>
                  new Tab().cursor_pointer().label(label)
                )
              )
          )
          .child(
            this.adbMode === 0
              ? h_flex()
                  .gap_2()
                  .child(
                    input(
                      'kc-pair-port',
                      this.pairPort,
                      'Pairing port'
                    ).flex_1()
                  )
                  .child(
                    input('kc-pair-pin', this.pairPin, 'Pairing PIN').w(84)
                  )
                  .child(
                    new Button('kc-adb-pair')
                      .cursor_pointer()
                      .primary()
                      .label('Pair')
                      .disabled(off || !host)
                      .loading(this.busy.has('adbPair'))
                      .on_click((_e, cx) =>
                        this.run(
                          'adbPair',
                          {
                            address: `${host}:${this.pairPort.value().trim()}`,
                            pin: this.pairPin.value().trim()
                          },
                          cx,
                          'adbPair',
                          () => {
                            this.adbMode = 1;
                          }
                        )
                      )
                  )
              : h_flex()
                  .gap_2()
                  .child(
                    input(
                      'kc-connect-address',
                      this.connectAddress,
                      'Address and debug port'
                    ).flex_1()
                  )
                  .child(
                    new Button('kc-adb-connect')
                      .cursor_pointer()
                      .primary()
                      .label('Connect')
                      .disabled(off)
                      .loading(this.busy.has('adbConnect'))
                      .on_click((_e, cx) => {
                        const typed = this.connectAddress.value().trim();
                        // a bare port goes to the phone's address
                        const address = /^\d+$/.test(typed)
                          ? `${host}:${typed}`
                          : typed;
                        this.run(
                          'adbConnect',
                          { id, address },
                          cx,
                          'adbConnect',
                          () => {
                            this.adbSetup = false;
                          }
                        );
                      })
                  )
          )
      );
    }

    const o = this.castOptions;
    const quality: Element[] = [
      new TabBar('kc-preset')
        .variant('segmented')
        .size('small')
        .self_start()
        .selected_index(this.preset)
        .on_change((index, cx) => {
          this.preset = index;
          if (index < CUSTOM) {
            const { res, br, fps } = PRESETS[index];
            this.castOptions = { ...this.castOptions, res, br, fps };
            for (const q of QUALITY)
              this.quality[q.key].set_value(this.castOptions[q.key] / q.per);
            store('cast', this.castOptions);
          }
          cx.notify();
        })
        .children(
          [...PRESETS.map((p) => p.label), 'Custom'].map((label) =>
            new Tab().cursor_pointer().label(label)
          )
        )
    ];
    if (this.preset === CUSTOM) {
      quality.push(
        v_flex()
          .gap_2()
          .children(
            QUALITY.map((q) =>
              h_flex()
                .items_center()
                .gap_2()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(div().w_8().font_semibold().child(q.short))
                .child(slider(this.quality[q.key], theme, false))
                .child(
                  div()
                    .w_16()
                    .text_right()
                    .text_color(theme.foreground)
                    .child(`${o[q.key]}${q.unit}`)
                )
            )
          )
      );
    } else {
      quality.push(
        div()
          .text_xs()
          .text_color(theme.muted_foreground)
          .child(`${o.res}p · ${o.br} Mbps · ${o.fps} fps`)
      );
    }

    const option = (key: 'record' | 'screenOff', label: string) =>
      h_flex()
        .items_center()
        .justify_between()
        .child(div().text_sm().font_medium().child(label))
        .child(
          new Switch(`kc-${key}`)
            .size('small')
            .checked(o[key])
            .on_change((on, cx) => {
              this.castOptions = { ...this.castOptions, [key]: on };
              store('cast', this.castOptions);
              cx.notify();
            })
        );

    const castButton = new Button('kc-cast')
      .cursor_pointer()
      .w_full()
      .loading(this.busy.has('cast'))
      .child(
        h_flex()
          .items_center()
          .gap_2()
          .child(
            new Icon(
              state.casting ? 'icons/circle-stop.svg' : 'icons/cast.svg'
            ).size('small')
          )
          .child(state.casting ? 'Stop' : 'Cast')
      )
      .tooltip(
        connected
          ? 'Mirror the phone with scrcpy'
          : 'Connect wireless debugging first'
      );
    return [
      section(theme, 'Connection', group(theme, connection)),
      section(theme, 'Quality', group(theme, quality)),
      section(
        theme,
        'Options',
        group(theme, [
          option('record', 'Record session'),
          option('screenOff', 'Turn phone screen off')
        ])
      ),
      (state.casting ? castButton.danger() : castButton.primary())
        .disabled(!state.casting && (off || !connected))
        .on_click((_e, cx) =>
          state.casting
            ? this.run('stopCast', { id }, cx)
            : this.run(
                'cast',
                { id, serial: state.serial, options: this.castOptions },
                cx
              )
        )
    ];
  }

  messages(device: Device, theme: Theme): Element[] {
    const off = !device.reachable;
    const dest = this.dest.trim();
    const query = dest.toLowerCase();
    const isFavorite = this.favorites.some(
      (f) => f.number === dest || (f.name && f.name.toLowerCase() === query)
    );
    const shown = this.favorites.filter(
      (f) =>
        !query ||
        f.number.toLowerCase().includes(query) ||
        f.name.toLowerCase().includes(query)
    );
    // a favorite's name sends to its number
    const number =
      this.favorites.find((f) => f.name && f.name.toLowerCase() === query)
        ?.number ?? dest;

    const rows: Element[] = [
      h_flex()
        .items_center()
        .gap_2()
        .child(
          new InputGroup('kc-dest')
            .flex_1()
            .addon(
              new InputGroupAddon('kc-dest-icon').child(
                new Icon('icons/user.svg').size('small')
              )
            )
            .input(
              new InputGroupInput(this.destInput)
                .aria_label('Phone number or contact')
                .value(this.dest)
                .on_change((value, cx) => {
                  this.dest = value;
                  cx.notify();
                })
            )
        )
        .child(
          (isFavorite
            ? iconButton(
                'kc-fav',
                'icons/star-fill.svg',
                'Remove favorite'
              ).secondary()
            : iconButton(
                'kc-fav',
                'icons/star.svg',
                'Favorite this number'
              ).ghost()
          )
            .disabled(!dest)
            .on_click((_e, cx) => {
              if (isFavorite) {
                this.saveFavorites(
                  this.favorites.filter(
                    (f) =>
                      !(
                        f.number === dest ||
                        (f.name && f.name.toLowerCase() === query)
                      )
                  )
                );
              } else {
                this.saveFavorites([
                  ...this.favorites,
                  { number: dest, name: '' }
                ]);
                this.rename(dest, '');
              }
              cx.notify();
            })
        )
    ];
    for (const f of shown) {
      if (this.editing === f.number) {
        rows.push(
          h_flex()
            .items_center()
            .gap_2()
            .child(
              input('kc-fav-name', this.nameInput, 'Contact name').flex_1()
            )
            .child(
              iconButton('kc-fav-save', 'icons/check.svg', 'Save name')
                .outline()
                .on_click((_e, cx) => {
                  const name = this.nameInput.value().trim();
                  this.saveFavorites(
                    this.favorites.map((x) =>
                      x.number === f.number ? { ...x, name } : x
                    )
                  );
                  this.editing = null;
                  cx.notify();
                })
            )
        );
        continue;
      }
      const row = h_flex()
        .items_center()
        .gap_2()
        .child(text(theme, f.name || f.number, f.name ? f.number : 'No name'));
      if (this.editMode) {
        row
          .child(
            iconButton(
              `kc-fav-rename-${f.number}`,
              'icons/pencil.svg',
              'Rename'
            )
              .ghost()
              .on_click((_e, cx) => {
                this.rename(f.number, f.name);
                cx.notify();
              })
          )
          .child(
            iconButton(
              `kc-fav-remove-${f.number}`,
              'icons/trash.svg',
              'Remove favorite'
            )
              .ghost()
              .on_click((_e, cx) => {
                this.saveFavorites(
                  this.favorites.filter((x) => x.number !== f.number)
                );
                cx.notify();
              })
          );
      } else {
        row.child(
          new Button(`kc-fav-use-${f.number}`)
            .cursor_pointer()
            .ghost()
            .size('small')
            .label('Use')
            .on_click((_e, cx) => {
              this.dest = f.number;
              cx.notify();
            })
        );
      }
      rows.push(row);
    }
    if (shown.length === 0) {
      rows.push(
        h_flex()
          .justify_center()
          .text_xs()
          .text_color(theme.muted_foreground)
          .child(query ? 'No matching contacts' : 'No favorite numbers yet')
      );
    }

    const edit = new Button('kc-fav-edit')
      .cursor_pointer()
      .ghost()
      .size('small')
      .label(this.editMode ? 'Done' : 'Edit')
      .on_click((_e, cx) => {
        this.editMode = !this.editMode;
        this.editing = null;
        cx.notify();
      });

    return [
      section(theme, 'Recipient', group(theme, rows), edit),
      section(
        theme,
        'Message',
        h_flex()
          .gap_2()
          .child(
            new InputGroup('kc-text').flex_1().input(
              new InputGroupInput(this.textInput)
                .aria_label('Message')
                .value(this.text)
                .on_change((value, cx) => {
                  this.text = value;
                  cx.notify();
                })
            )
          )
          .child(
            new Button('kc-send')
              .cursor_pointer()
              .primary()
              .disabled(off || !number || !this.text.trim())
              .loading(this.busy.has('sms'))
              .child(
                h_flex()
                  .items_center()
                  .gap_2()
                  .child(new Icon('icons/send.svg').size('small'))
                  .child('Send')
              )
              .on_click((_e, cx) =>
                this.run(
                  'sms',
                  { id: device.id, number, text: this.text.trim() },
                  cx,
                  'sms',
                  () => {
                    this.text = '';
                  }
                )
              )
          )
      )
    ];
  }

  devices(snap: Snapshot, theme: Theme): Element[] {
    const current = this.device();
    const paired = snap.devices.filter((d) => d.paired);
    const nearby = snap.devices.filter(
      (d) => !d.paired && (d.reachable || d.pairRequestedByPeer)
    );
    const parts: Element[] = [];
    if (paired.length) {
      parts.push(
        section(
          theme,
          'Paired',
          group(
            theme,
            paired.map((d) =>
              h_flex()
                .items_center()
                .gap_2p5()
                .child(
                  tile(theme, DEVICE_ICON[d.type] ?? 'icons/smartphone.svg')
                )
                .child(
                  text(
                    theme,
                    h_flex()
                      .items_center()
                      .gap_1p5()
                      .child(
                        dot(d.reachable ? ONLINE : tint(theme.foreground, 0.3))
                      )
                      .child(div().truncate().child(d.name)),
                    d.reachable
                      ? [d.address, d.network?.type]
                          .filter(Boolean)
                          .join(' · ') || 'Connected'
                      : 'Offline'
                  )
                )
                .child(
                  new Button(`kc-select-${d.id}`)
                    .cursor_pointer()
                    .outline()
                    .size('small')
                    .label(d.id === current?.id ? 'Selected' : 'Select')
                    .disabled(d.id === current?.id)
                    .on_click((_e, cx) => this.select(d.id, cx))
                )
                .child(
                  iconButton(
                    `kc-unpair-${d.id}`,
                    'icons/unlink.svg',
                    `Unpair ${d.name}`
                  )
                    .ghost()
                    .loading(this.busy.has(`unpair:${d.id}`))
                    .on_click((_e, cx) =>
                      this.run('unpair', { id: d.id }, cx, `unpair:${d.id}`)
                    )
                )
            )
          )
        )
      );
    }
    if (nearby.length) {
      parts.push(
        section(
          theme,
          'Available',
          group(
            theme,
            nearby.map((d) => {
              const row = h_flex()
                .items_center()
                .gap_2p5()
                .child(
                  tile(theme, DEVICE_ICON[d.type] ?? 'icons/smartphone.svg')
                )
                .child(
                  text(
                    theme,
                    d.name,
                    d.pairRequestedByPeer
                      ? 'Wants to pair'
                      : d.pairRequested
                        ? 'Waiting for the phone…'
                        : 'Visible on this network'
                  )
                );
              if (d.pairRequestedByPeer) {
                row
                  .child(
                    this.action(
                      `kc-reject-${d.id}`,
                      'Reject',
                      'cancelPairing',
                      {
                        id: d.id
                      }
                    ).ghost()
                  )
                  .child(
                    this.action(
                      `kc-accept-${d.id}`,
                      'Accept',
                      'acceptPairing',
                      {
                        id: d.id
                      }
                    ).primary()
                  );
              } else if (d.pairRequested) {
                row.child(
                  this.action(`kc-cancel-${d.id}`, 'Cancel', 'cancelPairing', {
                    id: d.id
                  }).outline()
                );
              } else {
                row.child(
                  this.action(`kc-pair-${d.id}`, 'Pair', 'pair', {
                    id: d.id
                  }).primary()
                );
              }
              return row;
            })
          )
        )
      );
    }
    return parts;
  }

  rename(number: string, name: string): void {
    this.editing = number;
    this.nameInput.set_value(name);
  }

  saveFavorites(favorites: Favorite[]): void {
    this.favorites = favorites;
    store('favorites', favorites);
  }

  /** A small labelled button that runs service `method` */
  action(
    id: string,
    label: string,
    method: string,
    args: JsonValue
  ): ButtonElement {
    return new Button(id)
      .cursor_pointer()
      .size('small')
      .label(label)
      .loading(this.busy.has(method))
      .on_click((_e, cx) => this.run(method, args, cx));
  }

  /** Calls the service, which reports the outcome through state `msg`; `done` runs on success */
  run(
    method: string,
    args: JsonValue,
    cx: Context,
    key = method,
    done?: () => void
  ): void {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      const answer = await call(method, args);
      if (!(answer && typeof answer === 'object' && 'message' in answer))
        done?.();
      this.busy.delete(key);
      cx.notify();
    });
  }
}

/** A titled block: the uppercase label, an optional action at its right, the content */
function section(
  theme: Theme,
  title: string,
  content: Element,
  action?: Element
): Element {
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
        .child(action ?? div())
    )
    .child(content);
}

/** Rows in corona's `card()`, divided by its border */
function group(theme: Theme, rows: Element[]): Element {
  return v_flex()
    .rounded_xl()
    .border_1()
    .border_color(theme.border)
    .bg(theme.accent)
    .overflow_hidden()
    .children(
      rows.map((row, i) => {
        const cell = div().px_3().py_2p5().child(row);
        return i ? cell.border_t_1().border_color(theme.border) : cell;
      })
    );
}

function scroll(id: string): NativeElement {
  return v_flex().id(id).flex_1().min_h_0().overflow_y_scroll().gap_4();
}

function empty(theme: Theme, message: string): Element {
  return v_flex()
    .flex_1()
    .items_center()
    .justify_center()
    .gap_2()
    .text_sm()
    .text_color(theme.muted_foreground)
    .child(new Icon('icons/smartphone.svg').size('large'))
    .child(message);
}

/** The 32 px icon square in front of a row */
function tile(theme: Theme, icon: string): Element {
  return div()
    .flex_none()
    .size_8()
    .flex()
    .items_center()
    .justify_center()
    .rounded_lg()
    .bg(theme.muted)
    .child(new Icon(icon).size('small'));
}

function text(theme: Theme, title: string | Element, desc: string): Element {
  return v_flex()
    .flex_1()
    .min_w_0()
    .child(div().text_sm().font_medium().truncate().child(title))
    .child(
      div().text_xs().truncate().text_color(theme.muted_foreground).child(desc)
    );
}

function input(
  id: string,
  state: InputState,
  label: string
): InputGroupElement {
  return new InputGroup(id).input(new InputGroupInput(state).aria_label(label));
}

/** gpui-component's slider look: a 6 px groove, the primary fill, a ringed 16 px thumb */
function slider(state: SliderState, theme: Theme, disabled: boolean): Element {
  // px_2 like corona's dashboard sliders: the thumb overhangs the track by half its width
  return Slider.new(state)
    .flex_1()
    .px_2()
    .opacity(disabled ? 0.5 : 1)
    .child(
      SliderTrack.new(state)
        .flex()
        .items_center()
        .h_6()
        .w_full()
        .when(!disabled, (el) => el.cursor_pointer())
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
                .child(
                  div().size_full().rounded_full().bg(theme.primary_foreground)
                )
            )
        )
    );
}

function headerButton(id: string, icon: string, label: string): ButtonElement {
  return new Button(id)
    .cursor_pointer()
    .size_8()
    .p_0()
    .tooltip(label)
    .child(new Icon(icon).size('small'));
}

function iconButton(id: string, icon: string, label: string): ButtonElement {
  // square, like the design's icon-sm: 28 px without padding
  return new Button(id)
    .cursor_pointer()
    .size('small')
    .size_7()
    .p_0()
    .tooltip(label)
    .child(new Icon(icon).size('small'));
}

/** Where the track is now: the reported position, moved on while playing */
function position(media: {
  position: number;
  at: number;
  playing: boolean;
  length: number;
}): number {
  return Math.min(
    media.length,
    media.position + (media.playing ? Date.now() - media.at : 0)
  );
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function single(value: SliderValue): number {
  return Array.isArray(value) ? value[1] : value;
}

function presetOf(o: CastOptions): number {
  const index = PRESETS.findIndex(
    (p) => p.res === o.res && p.br === o.br && p.fps === o.fps
  );
  return index < 0 ? CUSTOM : index;
}

/** `localStorage`, which may be off: then nothing is kept */
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`kdeconnect: keeping ${key}: ${error}`);
  }
}
