import { nextCall, reply, fail, getState, setState } from 'corona/plugin';
import type { Call, JsonValue } from 'corona/plugin';
import { notify, nextAction } from 'corona/notifications';
import {
  call as dbusCall,
  getProperty,
  nameHasOwner,
  subscribe,
  nextSignal
} from 'corona/dbus';
import type { Rule } from 'corona/dbus';
import * as secrets from 'corona/secrets';
import { readFile } from 'fs/promises';
import {
  listenRedirect,
  nextRedirect,
  openUri,
  pickFiles
} from 'corona/desktop';
import { open } from 'fs/promises';
import { nextSleepEvent } from 'corona/power';
import { closePanel, openPanel } from 'corona/surface';
import { get, set, setOptions } from 'corona/settings';
import { t } from 'corona/i18n';
import process from 'process';
import type { ChildProcess } from 'process';
import { connect } from 'net';
import type { Socket } from 'net';
import { Buffer } from 'buffer';
import type { AsyncContext } from 'gpui-kit';
import { message, ok } from './util.ts';

const KDECONNECT = 'org.kde.kdeconnect';
const TAILSCALE = '/run/tailscale/tailscaled.sock';
const TEST_URL = 'https://example.com/';

/** What `call(method)` in a view and `corona ipc plugin demo <method>` reach */
const methods: Record<string, (args: JsonValue) => Promise<JsonValue>> = {
  ping,
  time,
  spawn,
  notify: notifyAndWait,
  dbus,
  tailscale,
  fetch: fetchBoth,
  secret,
  pick,
  richNotify,
  stdin,
  files,
  unixFetch,
  ipnBus,
  settings,
  secretSetting,
  oauth
};

/** What the dynamic `favorite` select offers, set by the service at start */
const FAVORITES = [
  { value: 'none', label: 'None' },
  { value: 'tea', label: 'Tea' },
  { value: 'coffee', label: 'Coffee' },
  { value: 'water', label: 'Water' }
];

export default async function main(cx: AsyncContext): Promise<void> {
  let beats = 0;
  cx.timer.every(1000, () => {
    if (get('heartbeat')) setState('heartbeat', ++beats);
  });
  // KDE Connect only emits custom signals (battery, reachability, ...)
  void watch({
    bus: 'session',
    sender: KDECONNECT,
    pathNamespace: '/modules/kdeconnect'
  });
  const options = setOptions('favorite', FAVORITES);
  if (options) console.warn(`demo: setOptions: ${options.message}`);
  void sleepEvents();

  while (true) {
    const call = await nextCall();
    if ('message' in call) break; // the service is stopping
    // not awaited: `notify` waits for a click while other calls go on
    void answer(call);
  }
}

async function answer({ id, method, args }: Call): Promise<void> {
  const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (!handler) {
    fail(id, t('error.unknown', { method }));
    return;
  }
  try {
    reply(id, await handler(args));
  } catch (error) {
    fail(id, message(error));
  }
}

/** Pushes what `rule` matches into state `signals`, newest first */
async function watch(rule: Rule): Promise<void> {
  try {
    const id = ok(await subscribe(rule));
    while (true) {
      const signal = ok(await nextSignal(id));
      if (!signal) return;
      const seen = getState('signals');
      const line = `${signal.member} ${JSON.stringify(signal.args)}`;
      setState(
        'signals',
        [line, ...(Array.isArray(seen) ? seen : [])].slice(0, 8)
      );
    }
  } catch (error) {
    console.warn(`demo: watching ${rule.sender}: ${message(error)}`);
  }
}

async function ping(): Promise<JsonValue> {
  return {
    pong: true,
    at: new Date().toISOString(),
    greeting: get('greeting')
  };
}

/** `date` resolved through the granted PATH */
async function time(): Promise<JsonValue> {
  const out = await process.run('date', ['+%F %T %Z']);
  if (out.code !== 0)
    throw new Error(out.stderr.trim() || `date exited ${out.code}`);
  return out.stdout.trim();
}

let child: ChildProcess | null = null;

/** A short `sh` loop whose lines stream into state `spawn` */
async function spawn(): Promise<JsonValue> {
  if (child) throw new Error(t('error.running'));
  const script =
    'echo "HOME=$HOME"; for i in 1 2 3 4 5; do echo "line $i"; sleep 1; done; echo bye >&2; exit 3';
  const running = process.spawn('sh', ['-c', script]);
  child = running;
  const lines: string[] = [];
  const publish = (exit: JsonValue, stderr: string | null) =>
    setState('spawn', { pid: running.pid, lines: [...lines], exit, stderr });
  publish(null, null);
  void (async () => {
    try {
      for (
        let line = await running.readLine();
        line !== null;
        line = await running.readLine()
      ) {
        lines.push(line);
        publish(null, null);
      }
      const stderr = await running.readErrLine();
      const status = await running.wait();
      publish(status.code ?? `signal ${status.signal}`, stderr);
    } finally {
      child = null;
    }
  })();
  return { pid: running.pid };
}

/** Answers with the action the user picks; the call times out after 30 s, the state still follows */
async function notifyAndWait(): Promise<JsonValue> {
  const id = ok(
    await notify({
      summary: t('notify.summary'),
      body: t('notify.body', { greeting: get('greeting') }),
      icon: 'dialog-information',
      urgency: get('urgency'),
      actions: [
        { key: 'default', label: t('notify.open') },
        { key: 'yes', label: t('notify.yes') },
        { key: 'no', label: t('notify.no') }
      ]
    })
  );
  return waitForAction(id);
}

/** The first action picked, or reply typed, on notification `id`, also kept in state `action` */
async function waitForAction(id: number): Promise<JsonValue> {
  setState('action', t('notify.waiting', { id }));
  while (true) {
    // every waiter gets every action of the plugin's notifications
    const action = ok(await nextAction());
    if (action.id !== id) continue;
    const picked =
      action.text == null ? action.key : `${action.key}: ${action.text}`;
    setState('action', t('notify.picked', { id, key: picked }));
    return { id, key: action.key, text: action.text ?? null };
  }
}

async function dbus(): Promise<JsonValue> {
  const kdeconnect = ok(await nameHasOwner('session', KDECONNECT));
  let devices: JsonValue = null;
  if (kdeconnect) {
    // `devices` is a Qt overload (0, 1 and 2 args): no signature, so the 2-argument one is picked by arity
    const ids = ok(
      await dbusCall({
        bus: 'session',
        dest: KDECONNECT,
        path: '/modules/kdeconnect',
        iface: 'org.kde.kdeconnect.daemon',
        method: 'devices',
        args: [false, false]
      })
    );
    const list = Array.isArray(ids) ? ids.map(String) : [];
    devices = await Promise.all(
      list.map(async (device) => ({
        id: device,
        name: ok(
          await getProperty({
            bus: 'session',
            dest: KDECONNECT,
            path: `/modules/kdeconnect/devices/${device}`,
            iface: 'org.kde.kdeconnect.device',
            name: 'name'
          })
        )
      }))
    );
  }
  return { kdeconnect, devices };
}

type TailscaleStatus = {
  BackendState?: string;
  Self?: { HostName?: string; TailscaleIPs?: string[] };
  Peer?: Record<string, unknown>;
};

/** LocalAPI over the daemon's unix socket; HTTP/1.0 so the body ends at EOF, unchunked */
async function tailscale(): Promise<JsonValue> {
  let socket: Socket;
  try {
    socket = await connect({ path: TAILSCALE });
  } catch (error) {
    return { available: false, error: message(error) };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    // bytes, not a string: `write` takes a Uint8Array too
    const request =
      'GET /localapi/v0/status HTTP/1.0\r\nHost: local-tailscaled.sock\r\n\r\n';
    await socket.write(new Uint8Array(Buffer.from(request)));
    for (
      let chunk = await socket.read();
      chunk !== null && size < 4 << 20;
      chunk = await socket.read()
    ) {
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    socket.close();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const text = Buffer.from(bytes).toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  const statusLine = text.slice(0, text.indexOf('\r\n'));
  const body = split < 0 ? '' : text.slice(split + 4);
  if (!/ 200 /.test(statusLine)) {
    // 403 without operator rights: `tailscale set --operator=$USER`
    return { available: true, status: statusLine, body: body.slice(0, 300) };
  }
  const status = JSON.parse(body) as TailscaleStatus;
  return {
    available: true,
    status: statusLine,
    backend: status.BackendState ?? null,
    host: status.Self?.HostName ?? null,
    ips: status.Self?.TailscaleIPs ?? [],
    peers: Object.keys(status.Peer ?? {}).length
  };
}

/** Once buffered, once streamed chunk by chunk */
async function fetchBoth(): Promise<JsonValue> {
  const response = await fetch(TEST_URL, { timeout: 10_000 });
  const bytes = (await response.arrayBuffer()).byteLength;

  const stream = await fetch(TEST_URL, { stream: true, timeout: 10_000 });
  let chunks = 0;
  let streamed = 0;
  try {
    for (
      let chunk = await stream.read();
      chunk !== null;
      chunk = await stream.read()
    ) {
      chunks++;
      streamed += chunk.length;
    }
  } finally {
    stream.close();
  }
  return {
    status: response.status,
    bytes,
    streamStatus: stream.status,
    chunks,
    streamed
  };
}

/** A round trip through the user's keyring */
async function secret(): Promise<JsonValue> {
  const key = 'demo-token';
  const value = `token-${Date.now()}`;
  ok(await secrets.set(key, value));
  const read = ok(await secrets.get(key));
  ok(await secrets.remove(key));
  const afterRemove = ok(await secrets.get(key));
  return { stored: value, read, matches: read === value, afterRemove };
}

/**
 * The file picker is a normal window, below the panel's overlay layer, and a
 * panel's view (with its pending promises) is gone once it closes. So the
 * service picks: it closes the panel, waits for the dialog, keeps the paths in
 * the shared state and opens the panel again.
 */
async function pick(): Promise<JsonValue> {
  closePanel('main');
  const picked = ok(
    await pickFiles({ multiple: true, acceptLabel: t('panel.pick') })
  );
  // `null` when cancelled: keep the last pick
  if (picked) setState('picked', picked);
  openPanel('main');
  return picked;
}

/** Pushes each suspend and resume into state `sleep` */
async function sleepEvents(): Promise<void> {
  while (true) {
    const event = await nextSleepEvent();
    if ('message' in event) return; // the service is stopping
    setState(
      'sleep',
      `${event.sleeping ? 'suspending' : 'resumed'} at ${new Date().toLocaleTimeString()}`
    );
  }
}

/** Markup, a picture and an inline reply; answers with the click or the typed text */
async function richNotify(): Promise<JsonValue> {
  const id = ok(
    await notify({
      summary: t('notify.rich_summary'),
      body: t('notify.rich_body'),
      // the PNG through the `fs.read` grant, sent as the notification's picture
      image: await readFile('assets/gradient.png'),
      actions: [{ key: 'open', label: t('notify.open') }],
      reply: { placeholder: t('notify.reply_placeholder') },
      timeout: 30_000
    })
  );
  return waitForAction(id);
}

/** `closeStdin` ends the child's input after the queued writes */
async function stdin(): Promise<JsonValue> {
  const script =
    'n=0; while read l; do n=$((n+1)); echo "got $l"; done; echo "eof after $n lines"';
  const child = process.spawn('sh', ['-c', script]);
  await child.write('first\n');
  await child.write(new Uint8Array(Buffer.from('second\n')));
  await child.closeStdin();
  const lines: string[] = [];
  for (
    let line = await child.readLine();
    line !== null;
    line = await child.readLine()
  )
    lines.push(line);
  const status = await child.wait();
  return { lines, code: status.code };
}

/** A file handle in the data dir: write, append, then read back in 4-byte pieces */
async function files(): Promise<JsonValue> {
  const path = 'demo-file.bin';
  let file = await open(path, 'w');
  await file.write('hello ');
  await file.write(new Uint8Array([0, 1, 2, 255]));
  await file.close();
  file = await open(path, 'a');
  await file.write(' appended');
  await file.close();
  // `r+` opens through the write grant, so the relative path lands in `${dataDir}` like the writes
  file = await open(path, 'r+');
  const pieces: number[] = [];
  const all: number[] = [];
  try {
    for (
      let chunk = await file.read(4);
      chunk !== null;
      chunk = await file.read(4)
    ) {
      pieces.push(chunk.length);
      all.push(...chunk);
    }
  } finally {
    await file.close();
  }
  return {
    bytes: all.length,
    pieces: pieces.length,
    text: Buffer.from(all).toString('utf8')
  };
}

/** The same LocalAPI as `tailscale`, but `fetch` speaks HTTP over the unix socket */
async function unixFetch(): Promise<JsonValue> {
  const response = await fetch(
    'http://local-tailscaled.sock/localapi/v0/status?peers=false',
    {
      unix: TAILSCALE,
      timeout: 5_000
    }
  );
  const text = await response.text();
  if (!response.ok)
    return { status: response.status, body: text.slice(0, 300) };
  const status = JSON.parse(text) as TailscaleStatus;
  return {
    status: response.status,
    backend: status.BackendState ?? null,
    host: status.Self?.HostName ?? null
  };
}

/** The first line of the long-lived `watch-ipn-bus` NDJSON stream (mask 2: initial state) */
async function ipnBus(): Promise<JsonValue> {
  const stream = await fetch(
    'http://local-tailscaled.sock/localapi/v0/watch-ipn-bus?mask=2',
    {
      unix: TAILSCALE,
      stream: true,
      timeout: 5_000
    }
  );
  const bytes: number[] = [];
  try {
    while (!bytes.includes(10)) {
      const chunk = await stream.read();
      if (chunk === null) break;
      bytes.push(...chunk);
    }
  } finally {
    stream.close();
  }
  const line = Buffer.from(bytes).toString('utf8').split('\n')[0];
  if (stream.status !== 200)
    return { status: stream.status, body: line.slice(0, 300) };
  const notify = JSON.parse(line) as { State?: number };
  return { status: stream.status, state: notify.State ?? null };
}

/** Steps the dynamic `favorite` select through the options the service set */
async function settings(): Promise<JsonValue> {
  const before = get('favorite');
  const index = FAVORITES.findIndex((option) => option.value === before);
  const after = FAVORITES[(index + 1) % FAVORITES.length].value;
  ok(set('favorite', after));
  // the write lands after this render, so `get` still answers `before` here
  return { before, after };
}

/** The `token` secret setting, entered in corona's settings app */
async function secretSetting(): Promise<JsonValue> {
  const token = ok(await secrets.get('token'));
  // never echo the secret itself
  return token === null ? { set: false } : { set: true, length: token.length };
}

/** A loopback OAuth-style redirect: the browser is sent to our own listener */
async function oauth(): Promise<JsonValue> {
  const listening = ok(listenRedirect({ timeoutMs: 60_000 }));
  ok(
    openUri(
      `${listening.redirectUri}callback?code=demo-${Date.now()}&state=a%20b`
    )
  );
  const redirect = ok(await nextRedirect(listening.id));
  return { port: listening.port, ...redirect };
}
