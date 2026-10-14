import { View, div } from 'gpui-kit';
import type { AsyncContext, Context, Element } from 'gpui-kit';
import type { Props } from 'gpui-shell';
import type { Theme } from 'gpui-base';
import { Popover, h_flex, v_flex } from 'gpui-base';
import {
  Button,
  ErrorAlert,
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
import type { ButtonElement } from 'gpui-component';
import { call, getState, setState } from 'corona/plugin';
import type { JsonValue } from 'corona/plugin';
import { get } from 'corona/settings';
import { closePanel } from 'corona/surface';
import { openUri } from 'corona/desktop';
import type { Peer, PrefKey, Recent, Snapshot } from './service.ts';
import { CONN_TEXT, ONLINE, dot, logo, tint } from './ui.ts';

const TABS = ['Devices', 'Taildrop', 'Preferences'];

const PREFS: { key: PrefKey; label: string; desc: string }[] = [
  {
    key: 'shields',
    label: 'Shields up',
    desc: 'Block all incoming connections.'
  },
  {
    key: 'routes',
    label: 'Accept subnet routes',
    desc: 'Use routes advertised by other devices.'
  },
  {
    key: 'ssh',
    label: 'Tailscale SSH server',
    desc: 'Let tailnet devices SSH into this one.'
  },
  {
    key: 'advertise',
    label: 'Advertise as exit node',
    desc: 'Let other devices route traffic through this one.'
  },
  {
    key: 'lan',
    label: 'Allow LAN access',
    desc: 'Reach local devices while using an exit node.'
  }
];

const OS_ICON: Record<string, string> = {
  macOS: 'icons/laptop.svg',
  android: 'icons/smartphone.svg',
  iOS: 'icons/smartphone.svg'
};

/** A key expiring within this is warned about */
const EXPIRY_WARNING_MS = 7 * 24 * 3600 * 1000;

type Row = {
  icon?: string;
  title: string | Element;
  desc?: string;
  actions?: Element[];
  footer?: Element;
  variant?: 'muted' | 'outline';
};

/** Tailscale's state from the service, and its actions as service calls. */
export default class Panel extends View {
  declare tab: number;
  declare query: string;
  declare hideOffline: boolean;
  /** The peer whose actions menu is open */
  declare expanded: string | null;
  declare sendTo: string | null;
  /** Calls in flight, by `busyKey`, for loading buttons */
  declare busy: Set<string>;
  declare search: InputState;

  init(_props: Props | undefined, cx: AsyncContext): void {
    this.tab = 0;
    this.query = '';
    this.hideOffline = false;
    this.expanded = null;
    this.sendTo = null;
    this.busy = new Set();
    this.search = InputState('Name, IP or OS');
    // the bus keeps the state current; this catches up on what it rate-limited away
    cx.spawn(() => call('refresh'));
  }

  render(cx: Context): Element {
    const theme = cx.theme();
    const ts = getState('ts') as Snapshot | null;
    const conn = ts?.conn ?? 'starting';
    const online = ts?.peers.filter((peer) => peer.online).length ?? 0;
    const status =
      (getState('msg') as string | null) ??
      (ts ? `${online} of ${ts.peers.length} devices online` : '');

    const root = v_flex()
      .size_full()
      .p_2()
      .gap_2p5()
      .child(this.header(ts, theme));

    const expiry = ts?.keyExpiry
      ? Date.parse(ts.keyExpiry) - Date.now()
      : Infinity;
    if (conn === 'running' && expiry < EXPIRY_WARNING_MS) {
      const days = Math.max(0, Math.ceil(expiry / (24 * 3600 * 1000)));
      root.child(
        new ErrorAlert(
          'ts-expiry',
          `Your node key expires in ${days} days. Re-authenticate from the admin console.`
        )
      );
    }

    if (conn === 'unavailable') {
      root.child(
        row(theme, {
          title: 'Tailscale is not reachable',
          desc: ts?.error ?? undefined,
          actions: [
            this.action(
              'ts-retry',
              'Retry',
              'refresh',
              null,
              'refresh'
            ).primary()
          ],
          variant: 'outline'
        })
      );
    } else if (conn === 'needs-login') {
      root.child(
        row(theme, {
          title: 'Log in to Tailscale',
          desc: 'Authenticate this device to join your tailnet.',
          actions: [this.action('ts-login', 'Log in', 'login', null).primary()],
          variant: 'outline'
        })
      );
    } else if (conn === 'stopped') {
      root.child(
        row(theme, {
          title: 'Tailscale is stopped',
          desc: 'Start it to reach the devices on your tailnet.',
          actions: [
            this.action('ts-start', 'Start', 'setRunning', {
              on: true
            }).primary()
          ],
          variant: 'outline'
        })
      );
    } else if (conn === 'running' && ts) {
      root.children(this.connected(ts, theme));
    }

    return root.child(
      div()
        .flex_none()
        .px_0p5()
        .text_xs()
        .font_family(theme.typography.mono)
        .text_color(theme.muted_foreground)
        .child(status)
    );
  }

  header(ts: Snapshot | null, theme: Theme): Element {
    const conn = ts?.conn ?? 'starting';
    return h_flex()
      .flex_none()
      .items_center()
      .gap_2p5()
      .px_0p5()
      .child(logo(theme.foreground))
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .child(div().text_lg().font_semibold().child('Tailscale'))
          .child(
            h_flex()
              .items_center()
              .gap_1p5()
              .text_xs()
              .text_color(theme.muted_foreground)
              .child(
                dot(
                  conn === 'running'
                    ? ONLINE
                    : conn === 'needs-login'
                      ? theme.destructive
                      : tint(theme.foreground, 0.3)
                )
              )
              .child(CONN_TEXT[conn])
          )
      )
      .child(
        new Switch('ts-connection')
          .checked(conn === 'running')
          .disabled(conn !== 'running' && conn !== 'stopped')
          .tooltip('Tailscale connection')
          .on_change((on, cx) => this.run('setRunning', { on }, cx))
      )
      .child(
        headerButton(
          'ts-admin',
          'icons/external-link.svg',
          'Open admin console'
        )
          .ghost()
          .disabled(!ts?.admin)
          .on_click(() => this.open(ts.admin))
      )
      .child(
        headerButton('ts-refresh', 'icons/refresh-cw.svg', 'Refresh')
          .outline()
          .loading(this.busy.has('refresh'))
          .on_click((_e, cx) => this.run('refresh', null, cx))
      )
      .child(
        headerButton('ts-close', 'icons/x.svg', 'Close')
          .outline()
          .on_click(() => closePanel('main'))
      );
  }

  connected(ts: Snapshot, theme: Theme): Element[] {
    const parts: Element[] = [];
    if (ts.self) {
      const self = ts.self;
      parts.push(
        div()
          .flex_none()
          .rounded_lg()
          .bg(tint(theme.primary, 0.18))
          .child(
            row(theme, {
              icon: 'icons/house.svg',
              title: self.name,
              desc: `${self.ip} · This device`,
              actions: [
                iconButton('ts-self-ip', 'icons/copy.svg', 'Copy IP')
                  .ghost()
                  .on_click((_e, cx) =>
                    this.copy(self.ip, `${self.ip} (${self.name})`, cx)
                  ),
                iconButton('ts-self-name', 'icons/tag.svg', 'Copy name')
                  .ghost()
                  .on_click((_e, cx) => this.copy(self.name, self.name, cx))
              ]
            })
          )
      );
    }

    const exit = ts.exitNode
      ? ts.peers.find((peer) => peer.id === ts.exitNode)
      : null;
    if (ts.exitNode) {
      parts.push(
        row(theme, {
          icon: 'icons/globe.svg',
          title: `Exit node: ${exit?.name ?? ts.exitNode}`,
          actions: [
            this.action('ts-exit-off', 'Disable', 'setExit', {
              id: null
            }).outline()
          ],
          variant: 'outline'
        })
      );
    }

    parts.push(
      new TabBar('ts-tabs')
        .flex_none()
        .self_start()
        .variant('segmented')
        .selected_index(this.tab)
        .on_change((index, cx) => {
          this.tab = index;
          cx.notify();
        })
        .children(TABS.map((label) => new Tab().cursor_pointer().label(label)))
    );

    if (this.tab === 0) parts.push(...this.devices(ts, theme));
    else
      parts.push(
        v_flex()
          .id('ts-tab')
          .flex_1()
          .min_h_0()
          .overflow_y_scroll()
          .gap_2p5()
          .children(
            this.tab === 1
              ? this.taildrop(ts, theme)
              : this.preferences(ts, theme)
          )
      );
    return parts;
  }

  devices(ts: Snapshot, theme: Theme): Element[] {
    const online = ts.peers.filter((peer) => peer.online).length;
    const query = this.query.trim().toLowerCase();
    const shown = ts.peers.filter(
      (peer) =>
        (!this.hideOffline || peer.online || peer.id === ts.exitNode) &&
        (!query ||
          `${peer.name} ${peer.ip} ${peer.os}`.toLowerCase().includes(query))
    );
    return [
      h_flex()
        .flex_none()
        .items_center()
        .justify_between()
        .pt_1()
        .px_0p5()
        .child(
          h_flex()
            .gap_1()
            .text_sm()
            .font_medium()
            .child('Devices')
            .child(
              div()
                .font_normal()
                .text_color(theme.muted_foreground)
                .child(`${online}/${ts.peers.length} online`)
            )
        )
        .child(
          h_flex()
            .items_center()
            .gap_2()
            .text_xs()
            .text_color(theme.muted_foreground)
            .child('Hide offline')
            .child(
              new Switch('ts-hide-offline')
                .size('small')
                .checked(this.hideOffline)
                .on_change((on, cx) => {
                  this.hideOffline = on;
                  cx.notify();
                })
            )
        ),
      new InputGroup('ts-search')
        .flex_none()
        .addon(
          new InputGroupAddon('ts-search-icon').child(
            new Icon('icons/search.svg').size('small')
          )
        )
        .input(
          new InputGroupInput(this.search)
            .aria_label('Filter devices')
            .on_change((value, cx) => {
              this.query = value;
              cx.notify();
            })
        ),
      v_flex()
        .id('ts-devices')
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .gap_1p5()
        .children(shown.map((peer) => this.peer(peer, ts, theme)))
        .child(
          shown.length === 0
            ? div()
                .py_4()
                .text_center()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child('No devices match.')
            : div()
        )
    ];
  }

  peer(peer: Peer, ts: Snapshot, theme: Theme): Element {
    const isExit = ts.exitNode === peer.id;
    const actions: Element[] = [];
    if (peer.exitOption) {
      const label = isExit
        ? `Stop using ${peer.name} as exit node`
        : `Use ${peer.name} as exit node`;
      const button = iconButton(`ts-exit-${peer.id}`, 'icons/globe.svg', label)
        .disabled(!peer.online && !isExit)
        .loading(this.busy.has('setExit'))
        .on_click((_e, cx) =>
          this.run(
            'setExit',
            { id: isExit ? null : peer.id, name: peer.name },
            cx
          )
        );
      actions.push(isExit ? button.secondary() : button.ghost());
    }
    actions.push(
      iconButton(
        `ts-ip-${peer.id}`,
        'icons/copy.svg',
        `Copy IP of ${peer.name}`
      )
        .ghost()
        .on_click((_e, cx) =>
          this.copy(peer.ip, `${peer.ip} (${peer.name})`, cx)
        ),
      this.options(peer, theme)
    );

    return div()
      .flex_none()
      .opacity(peer.online ? 1 : 0.6)
      .child(
        row(theme, {
          icon: OS_ICON[peer.os] ?? 'icons/monitor.svg',
          title: h_flex()
            .items_center()
            .gap_1p5()
            .child(dot(peer.online ? ONLINE : tint(theme.foreground, 0.3)))
            .child(div().truncate().child(peer.name)),
          desc:
            peer.online || !peer.lastSeen
              ? peer.ip
              : `${peer.ip} · last seen ${seen(peer.lastSeen)}`,
          actions,
          variant: 'muted'
        })
      );
  }

  /** The ⋮ button and its menu: copy name, ping, SSH, send file */
  options(peer: Peer, theme: Theme): Element {
    const close = (cx: Context) => {
      this.expanded = null;
      cx.notify();
    };
    return Popover.new(`ts-more-${peer.id}`)
      .anchor('top_right')
      .open(this.expanded === peer.id)
      .on_open_change((open, cx) => {
        this.expanded = open ? peer.id : null;
        cx.notify();
      })
      .trigger(
        iconButton(
          `ts-more-button-${peer.id}`,
          'icons/ellipsis-vertical.svg',
          `Actions for ${peer.name}`
        ).ghost()
      )
      .content(
        v_flex()
          .min_w(170)
          .mt_1()
          .p_1()
          .gap_0p5()
          .rounded_lg()
          .border_1()
          .border_color(theme.border)
          .bg(theme.surface)
          .text_color(theme.surface_foreground)
          .shadow_md()
          .child(
            menuItem(
              theme,
              `ts-name-${peer.id}`,
              'icons/tag.svg',
              'Copy name',
              false,
              (cx) => {
                this.copy(peer.name, peer.name, cx);
                close(cx);
              }
            )
          )
          .child(
            menuItem(
              theme,
              `ts-ping-${peer.id}`,
              'icons/activity.svg',
              'Ping',
              !peer.online,
              (cx) => {
                this.run(
                  'ping',
                  { ip: peer.ip, name: peer.name },
                  cx,
                  `ping:${peer.ip}`
                );
                close(cx);
              }
            )
          )
          // ponytail: no portable "open a terminal"; copies the command instead
          .child(
            menuItem(
              theme,
              `ts-ssh-${peer.id}`,
              'icons/terminal.svg',
              'SSH',
              !peer.online,
              (cx) => {
                this.copy(
                  `ssh ${peer.ip}`,
                  `"ssh ${peer.ip}", paste it in a terminal`,
                  cx
                );
                close(cx);
              }
            )
          )
          .child(
            menuItem(
              theme,
              `ts-send-${peer.id}`,
              'icons/upload.svg',
              'Send file',
              !peer.online,
              (cx) => {
                close(cx);
                this.run('send', { ip: peer.ip, name: peer.name }, cx);
              }
            )
          )
      );
  }

  taildrop(ts: Snapshot, theme: Theme): Element[] {
    const folder = get('downloads');
    const waiting = ts.waiting ? `${ts.waiting} waiting · ` : '';
    const targets = ts.peers.filter((peer) => peer.online);
    const target = targets.find((peer) => peer.id === this.sendTo);
    const recent = (getState('recent') as Recent[] | null) ?? [];
    return [
      row(theme, {
        icon: 'icons/download.svg',
        title: 'Receive files',
        desc:
          waiting +
          (folder ? `Saved to ${folder}` : 'Asks for a folder the first time'),
        actions: [
          this.action('ts-receive', 'Receive', 'receive', null).outline()
        ],
        variant: 'muted'
      }),
      row(theme, {
        icon: 'icons/upload.svg',
        title: 'Send a file',
        desc: 'Pick an online device, then choose a file.',
        footer: h_flex()
          .items_center()
          .gap_2()
          .child(
            new Select(
              'ts-send-to',
              () => targets.map((peer) => ({ id: peer.id, label: peer.name })),
              (item) => div().child((item as { label: string }).label),
              (id, cx) => {
                this.sendTo = id;
                cx.notify();
              }
            )
              .flex_1()
              .placeholder('Send to…')
          )
          .child(
            new Button('ts-choose-file')
              .cursor_pointer()
              .primary()
              .label('Choose file…')
              .disabled(!target)
              .loading(this.busy.has('send'))
              .on_click((_e, cx) =>
                this.run('send', { ip: target.ip, name: target.name }, cx)
              )
          ),
        variant: 'muted'
      }),
      div().flex_none().pt_1().px_0p5().text_sm().font_medium().child('Recent'),
      ...(recent.length
        ? recent.map((entry) =>
            row(theme, {
              title: entry.file,
              desc: entry.meta,
              variant: 'outline'
            })
          )
        : [
            div()
              .px_0p5()
              .text_xs()
              .text_color(theme.muted_foreground)
              .child('Nothing sent or received yet.')
          ])
    ];
  }

  preferences(ts: Snapshot, theme: Theme): Element[] {
    return PREFS.map((pref) =>
      row(theme, {
        title: pref.label,
        desc: pref.desc,
        actions: [
          new Switch(`ts-pref-${pref.key}`)
            .size('small')
            .checked(ts.prefs[pref.key])
            .disabled(this.busy.has(`pref:${pref.key}`))
            .tooltip(pref.label)
            .on_change((on, cx) =>
              this.run(
                'setPref',
                { key: pref.key, on, label: pref.label },
                cx,
                `pref:${pref.key}`
              )
            )
        ],
        variant: 'muted'
      })
    );
  }

  /** A labelled button that runs service `method` */
  action(
    id: string,
    label: string,
    method: string,
    args: JsonValue,
    key = method
  ): ButtonElement {
    return new Button(id)
      .cursor_pointer()
      .label(label)
      .size('small')
      .loading(this.busy.has(key))
      .on_click((_e, cx) => this.run(method, args, cx, key));
  }

  /** Calls the service; it reports the outcome through state `msg` */
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

  copy(text: string, what: string, cx: Context): void {
    cx.write_to_clipboard(text);
    setState('msg', `Copied ${what}`);
  }

  open(url: string): void {
    const error = openUri(url);
    setState(
      'msg',
      error
        ? `✗ ${error.message}`
        : 'Opening the admin console in your browser…'
    );
  }
}

/** The design's Item: media, title and description, actions, an optional footer */
function row(
  theme: Theme,
  { icon, title, desc, actions, footer, variant }: Row
): Element {
  const item = v_flex().flex_none().gap_2().p_2().rounded_xl();
  // corona's `card()`: accent fill, border
  if (variant === 'muted')
    item.bg(theme.accent).border_1().border_color(theme.border);
  if (variant === 'outline') item.border_1().border_color(theme.border);
  const main = h_flex().items_center().gap_2();
  if (icon)
    main.child(new Icon(icon).size('small').text_color(theme.muted_foreground));
  main.child(
    v_flex()
      .flex_1()
      .min_w_0()
      .child(div().text_sm().font_medium().child(title))
      .child(
        desc
          ? div()
              .text_xs()
              .truncate()
              .text_color(theme.muted_foreground)
              .child(desc)
          : div()
      )
  );
  if (actions?.length)
    main.child(h_flex().flex_none().items_center().gap_1().children(actions));
  item.child(main);
  if (footer) item.child(footer);
  return item;
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

function headerButton(id: string, icon: string, label: string): ButtonElement {
  return new Button(id)
    .cursor_pointer()
    .size_8()
    .p_0()
    .tooltip(label)
    .child(new Icon(icon).size('small'));
}

/** A left-aligned menu row; `on_click` is dropped while disabled */
function menuItem(
  theme: Theme,
  id: string,
  icon: string,
  label: string,
  disabled: boolean,
  onClick: (cx: Context) => void
): Element {
  const item = h_flex()
    .id(id)
    .w_full()
    .items_center()
    .gap_2()
    .px_2()
    .py_1p5()
    .rounded_md()
    .text_sm()
    .child(new Icon(icon).size('small'))
    .child(label);
  if (disabled) return item.opacity(0.5);
  return item
    .cursor_pointer()
    .hover((el) => el.bg(theme.accent).text_color(theme.accent_foreground))
    .on_click((_e, cx) => onClick(cx));
}

/** `2026-10-10 17:42`, local time */
function seen(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
