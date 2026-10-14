import { View, div, image } from 'gpui-kit';
import type { AsyncContext, Context, Element } from 'gpui-kit';
import type { Props } from 'gpui-shell';
import { h_flex, v_flex } from 'gpui-base';
import { Button } from 'gpui-component';
import { readFile } from 'node:fs/promises';
import { call, getState } from 'corona/plugin';
import { language, t } from 'corona/i18n';
import { all } from 'corona/settings';
import { resumedAt, sleeping } from 'corona/power';
import { openPath, openUri } from 'corona/desktop';
import { failed, message } from './util.ts';

/** The service's methods, one button each */
const METHODS = [
  'ping',
  'time',
  'spawn',
  'notify',
  'dbus',
  'tailscale',
  'fetch',
  'secret',
  'richNotify',
  'stdin',
  'files',
  'unixFetch',
  'ipnBus',
  'settings',
  'secretSetting',
  'oauth'
];

interface Spawned {
  pid: number;
  lines: string[];
  exit: number | string | null;
  stderr: string | null;
}

/** A dashboard of every API: service calls, shared state, desktop, images, clipboard. */
export default class Panel extends View {
  /** Shown per method, the answer or the error */
  declare results: Record<string, string>;
  declare busy: Set<string>;
  /** The PNG read through the `fs.read` grant, for `image(Uint8Array)` */
  declare bytes: Uint8Array | null;

  init(_props: Props | undefined, cx: AsyncContext): void {
    this.results = {};
    this.busy = new Set();
    this.bytes = null;
    cx.spawn(async (cx) => {
      try {
        this.bytes = await readFile('assets/gradient.png');
      } catch (error) {
        this.results.image = `✗ ${message(error)}`;
      }
      cx.notify();
    });
  }

  render(_cx: Context): Element {
    const settings = all();
    const spawned = getState('spawn') as Spawned | null;
    const signals = getState('signals');
    return v_flex()
      .id('demo-panel')
      .size_full()
      .overflow_y_scroll()
      .gap_2()
      .p_4()
      .child(
        h_flex()
          .gap_2()
          .items_center()
          // Plugin-relative path, and the same file as raster bytes
          .child(image('assets/gradient.png').size_8())
          .child(this.bytes ? image(this.bytes).size_8() : div().size_8())
          .child(
            v_flex()
              .child(div().font_semibold().child(t('panel.title')))
              .child(
                div()
                  .text_xs()
                  .child(
                    t('panel.greeting', {
                      greeting: settings.greeting,
                      language: language()
                    })
                  )
              )
          )
      )
      .child(
        div()
          .text_xs()
          .child(
            t('panel.status', {
              count: getState('heartbeat') ?? '–',
              heartbeat: String(settings.heartbeat),
              urgency: settings.urgency
            })
          )
      )
      .child(
        div()
          .text_xs()
          .child(t('panel.favorite', { favorite: settings.favorite }))
      )
      .child(
        div()
          .text_xs()
          .child(
            t('panel.sleep', {
              event: String(getState('sleep') ?? '–'),
              resumed:
                resumedAt() === null
                  ? '–'
                  : new Date(resumedAt() * 1000).toLocaleTimeString(),
              sleeping: String(sleeping())
            })
          )
      )
      .child(div().font_semibold().child(t('panel.service')))
      .child(
        h_flex()
          .flex_wrap()
          .gap_1()
          .children(METHODS.map((method) => this.button(method)))
      )
      .child(div().font_semibold().child(t('panel.desktop')))
      .child(
        h_flex()
          .flex_wrap()
          .gap_1()
          .child(
            new Button('demo-pick')
              .label(t('panel.pick'))
              .size('small')
              .on_click((_e, cx) => this.pick(cx))
          )
          .child(
            new Button('demo-open-path')
              .label(t('panel.open_path'))
              .size('small')
              .on_click((_e, cx) => {
                const path = this.picked?.[0];
                const error = path
                  ? openPath(path)
                  : { message: t('panel.pick_first') };
                this.results.desktop = error
                  ? `✗ ${error.message}`
                  : t('panel.opened', { target: path });
                cx.notify();
              })
          )
          .child(
            new Button('demo-open-uri')
              .label(t('panel.open_uri'))
              .size('small')
              .on_click((_e, cx) => {
                const error = openUri('https://example.com/');
                this.results.desktop = error
                  ? `✗ ${error.message}`
                  : t('panel.opened', { target: 'https://example.com/' });
                cx.notify();
              })
          )
          .child(
            new Button('demo-copy')
              .label(t('panel.copy'))
              .size('small')
              .on_click((_e, cx) => {
                cx.write_to_clipboard(JSON.stringify(this.results, null, 2));
                this.results.clipboard = t('panel.copied');
                cx.notify();
              })
          )
      )
      .child(
        div()
          .text_xs()
          .child(t('panel.picked', { paths: this.picked?.join(', ') ?? '–' }))
      )
      .child(div().font_semibold().child(t('panel.results')))
      .children(
        Object.entries(this.results).map(([key, value]) =>
          div().text_xs().child(`${key}: ${value}`)
        )
      )
      .child(div().font_semibold().child(t('panel.spawn')))
      .child(
        div()
          .text_xs()
          .child(
            spawned
              ? t('panel.spawned', {
                  exit: spawned.exit ?? '…',
                  pid: spawned.pid,
                  stderr: spawned.stderr ?? ''
                })
              : '–'
          )
      )
      .children(
        (spawned?.lines ?? []).map((line) => div().text_xs().child(line))
      )
      .child(div().font_semibold().child(t('panel.signals')))
      .children(
        (Array.isArray(signals) ? signals.map(String) : ['–']).map((s) =>
          div().text_xs().child(s)
        )
      )
      .child(div().font_semibold().child(t('panel.action')))
      .child(
        div()
          .text_xs()
          .child(String(getState('action') ?? '–'))
      );
  }

  button(method: string): Element {
    return new Button(`demo-${method}`)
      .label(t(`button.${method}`))
      .size('small')
      .loading(this.busy.has(method))
      .on_click((_e, cx) => {
        this.busy.add(method);
        this.results[method] = t('panel.pending');
        cx.notify();
        cx.spawn(async (cx) => {
          const answer = await call(method);
          this.results[method] = failed(answer)
            ? `✗ ${answer.message}`
            : JSON.stringify(answer);
          this.busy.delete(method);
          cx.notify();
        });
      });
  }

  /** The service picks, since this panel closes for the dialog; see `pick` in service.ts */
  pick(cx: Context): void {
    cx.spawn(async (cx) => {
      const answer = await call('pick');
      if (failed(answer)) {
        this.results.desktop = `✗ ${answer.message}`;
      }
      cx.notify();
    });
  }

  /** What the service's last `pick` kept */
  get picked(): string[] | null {
    return getState('picked') as string[] | null;
  }
}
