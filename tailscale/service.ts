import { fail, getState, nextCall, reply, setState } from 'corona/plugin';
import type { Call, JsonValue } from 'corona/plugin';
import { openUri, pickFiles } from 'corona/desktop';
import { closePanel, openPanel } from 'corona/surface';
import { get, set } from 'corona/settings';
import process from 'node:process';
import { basename } from 'node:path';
import { Buffer } from 'node:buffer';
import type { AsyncContext } from 'gpui-kit';

const SOCKET = '/run/tailscale/tailscaled.sock';
const LOCALAPI = 'http://local-tailscaled.sock/localapi/v0/';
const HEADERS = { 'Sec-Tailscale': 'localapi' };
/** Ipn.NotifyWatchOpt: initial state, no private keys, rate-limited netmaps */
const WATCH_MASK = 2 | 16 | 256;
const EXIT_ROUTES = ['0.0.0.0/0', '::/0'];
const ADMIN: Record<string, string> = {
  'https://controlplane.tailscale.com':
    'https://login.tailscale.com/admin/machines',
  'https://login.tailscale.com': 'https://login.tailscale.com/admin/machines'
};

export type Conn =
  | 'running'
  | 'stopped'
  | 'needs-login'
  | 'starting'
  | 'unavailable';
export interface Peer {
  id: string;
  name: string;
  ip: string;
  os: string;
  online: boolean;
  lastSeen: string | null;
  exitOption: boolean;
}
export type PrefKey = 'shields' | 'routes' | 'ssh' | 'advertise' | 'lan';
/** What the views read from state `ts` */
export interface Snapshot {
  conn: Conn;
  error: string | null;
  self: { name: string; ip: string } | null;
  peers: Peer[];
  /** The stable id of the peer in use as exit node */
  exitNode: string | null;
  prefs: Record<PrefKey, boolean>;
  keyExpiry: string | null;
  /** The admin console, null for a custom control server */
  admin: string | null;
  /** Taildrop files waiting to be received */
  waiting: number;
}
/** State `recent`, newest first */
export interface Recent {
  file: string;
  meta: string;
}

interface Node {
  ID: string;
  HostName: string;
  DNSName: string;
  OS: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  LastSeen?: string;
  ExitNodeOption?: boolean;
  KeyExpiry?: string;
}
interface Status {
  BackendState: string;
  Self?: Node;
  Peer?: Record<string, Node>;
}
interface Prefs {
  ControlURL: string;
  WantRunning: boolean;
  ExitNodeID: string;
  ShieldsUp: boolean;
  RouteAll: boolean;
  RunSSH: boolean;
  ExitNodeAllowLANAccess: boolean;
  AdvertiseRoutes: string[] | null;
}

/** Each view-side preference and the `ipn.Prefs` field behind it, except `advertise` */
const PREF_FIELDS: Record<Exclude<PrefKey, 'advertise'>, string> = {
  lan: 'ExitNodeAllowLANAccess',
  routes: 'RouteAll',
  shields: 'ShieldsUp',
  ssh: 'RunSSH'
};

const CONN: Record<string, Conn> = {
  NeedsLogin: 'needs-login',
  NeedsMachineAuth: 'needs-login',
  Running: 'running',
  Stopped: 'stopped'
};

type Args = Record<string, JsonValue>;
/** Each answers with the line the panel shows */
const methods: Record<string, (args: Args) => Promise<string | null>> = {
  login,
  ping,
  receive,
  refresh: async () => {
    await refresh();
    return null;
  },
  send,
  setExit: async ({ id, name }) => {
    await patch({
      ExitNodeID: typeof id === 'string' ? id : '',
      ExitNodeIP: ''
    });
    return id ? `Exit node enabled: ${name}` : 'Exit node disabled';
  },
  setPref,
  setRunning: async ({ on }) => {
    await patch({ WantRunning: on === true });
    return on ? 'Tailscale connected' : 'Tailscale disconnected';
  }
};

let loginRequested = false;

export default async function main(cx: AsyncContext): Promise<void> {
  void watch(cx);
  while (true) {
    const call = await nextCall();
    if ('message' in call) {
      break;
    } // The service is stopping
    void answer(call);
  }
}

async function answer({ id, method, args }: Call): Promise<void> {
  const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (!handler) {
    fail(id, `unknown method ${method}`);
    return;
  }
  try {
    const line = await handler((args ?? {}) as Args);
    // Also through state: a call that outlives a closed panel still reaches the next one
    if (line) {
      setState('msg', line);
    }
    reply(id, line);
  } catch (error) {
    setState('msg', `✗ ${message(error)}`);
    fail(id, message(error));
  }
}

/**
 * Follows tailscaled's IPN bus, which sends a line for every state, prefs or
 * netmap change, and refreshes the snapshot on each. Reconnects with a backoff
 * while tailscaled is down.
 */
async function watch(cx: AsyncContext): Promise<void> {
  let delay = 1000;
  while (true) {
    try {
      const stream = await fetch(
        `${LOCALAPI}watch-ipn-bus?mask=${WATCH_MASK}`,
        {
          headers: HEADERS,
          stream: true,
          unix: SOCKET
        }
      );
      try {
        if (!stream.ok) {
          throw new Error(`watch-ipn-bus: HTTP ${stream.status}`);
        }
        delay = 1000;
        let rest = '';
        for (
          let chunk = await stream.read();
          chunk !== null;
          chunk = await stream.read()
        ) {
          const lines = (rest + Buffer.from(chunk).toString('utf8')).split(
            '\n'
          );
          rest = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim()) {
              notified(JSON.parse(line));
            }
          }
        }
      } finally {
        stream.close();
      }
    } catch (error) {
      unavailable(error);
    }
    await cx.sleep(delay);
    delay = Math.min(delay * 2, 60_000);
  }
}

function notified(notify: {
  BrowseToURL?: string | null;
  ErrMessage?: string | null;
}): void {
  // Only the login this plugin asked for opens a browser
  if (notify.BrowseToURL && loginRequested) {
    loginRequested = false;
    const error = openUri(notify.BrowseToURL);
    if (error) {
      setState('msg', `✗ ${error.message}`);
    }
  }
  if (notify.ErrMessage) {
    setState('msg', `✗ ${notify.ErrMessage}`);
  }
  queueRefresh();
}

let refreshing: Promise<void> | null = null;
let again = false;

/** Coalesces a burst of notifications into one refresh, and one more after it */
function queueRefresh(): void {
  if (refreshing) {
    again = true;
    return;
  }
  refreshing = (async () => {
    do {
      again = false;
      await refresh();
    } while (again);
    refreshing = null;
  })();
}

async function refresh(): Promise<void> {
  try {
    const [status, prefs, files] = await Promise.all([
      api('status') as Promise<Status>,
      api('prefs') as Promise<Prefs>,
      // Fails without Taildrop; not worth failing the rest for
      (api('files/') as Promise<unknown[] | null>).catch((): null => null)
    ]);
    setState('ts', snapshot(status, prefs, files?.length ?? 0));
  } catch (error) {
    unavailable(error);
  }
}

function snapshot(status: Status, prefs: Prefs, waiting: number): Snapshot {
  const self = status.Self;
  const peers = Object.values(status.Peer ?? {})
    .map((node): Peer => ({
      exitOption: node.ExitNodeOption,
      id: node.ID,
      ip: node.TailscaleIPs?.[0] ?? '',
      lastSeen: node.LastSeen?.startsWith('0001')
        ? null
        : (node.LastSeen ?? null),
      name: nodeName(node),
      online: node.Online,
      os: node.OS
    }))
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)
    );
  return {
    admin: ADMIN[prefs.ControlURL] ?? null,
    conn: CONN[status.BackendState] ?? 'starting',
    error: null,
    exitNode: prefs.ExitNodeID || null,
    keyExpiry: self?.KeyExpiry ?? null,
    peers,
    prefs: {
      advertise: EXIT_ROUTES.every((route) =>
        prefs.AdvertiseRoutes?.includes(route)
      ),
      lan: prefs.ExitNodeAllowLANAccess,
      routes: prefs.RouteAll,
      shields: prefs.ShieldsUp,
      ssh: prefs.RunSSH
    },
    self: self
      ? { ip: self.TailscaleIPs?.[0] ?? '', name: nodeName(self) }
      : null,
    waiting
  };
}

/** The MagicDNS label, like the admin console shows; the OS hostname without one */
function nodeName(node: Node): string {
  return node.DNSName?.split('.')[0] || node.HostName;
}

function unavailable(error: unknown): void {
  const last = getState('ts') as Snapshot | null;
  setState('ts', {
    admin: null,
    conn: 'unavailable',
    error: message(error),
    exitNode: null,
    keyExpiry: null,
    peers: [],
    prefs: last?.prefs ?? {
      advertise: false,
      lan: false,
      routes: false,
      shields: false,
      ssh: false
    },
    self: null,
    waiting: 0
  });
}

/** One LocalAPI request; the parsed JSON answer, null when empty */
async function api(
  path: string,
  method = 'GET',
  body?: JsonValue
): Promise<unknown> {
  const options: Parameters<typeof fetch>[1] = {
    headers: HEADERS,
    method,
    timeout: 15_000,
    unix: SOCKET
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(LOCALAPI + path, options);
  const text = await response.text();
  // 403 for write actions without operator rights
  if (!response.ok) {
    throw new Error(text.trim() || `${path}: HTTP ${response.status}`);
  }
  return text.trim() ? JSON.parse(text) : null;
}

/** Changes `fields` of `ipn.Prefs`, as `ipn.MaskedPrefs` wants them, and refreshes */
async function patch(fields: Args): Promise<void> {
  const masked: Args = { ...fields };
  for (const key of Object.keys(fields)) {
    masked[`${key}Set`] = true;
  }
  await api('prefs', 'PATCH', masked);
  await refresh();
}

async function login(): Promise<string> {
  // The URL comes as `BrowseToURL` on the bus, see `notified`
  loginRequested = true;
  await api('login-interactive', 'POST');
  return 'Opening the login page in your browser…';
}

async function setPref({ key, on, label }: Args): Promise<string> {
  const value = on === true;
  if (key === 'advertise') {
    const prefs = (await api('prefs')) as Prefs;
    const routes = (prefs.AdvertiseRoutes ?? []).filter(
      (route) => !EXIT_ROUTES.includes(route)
    );
    await patch({
      AdvertiseRoutes: value ? [...routes, ...EXIT_ROUTES] : routes
    });
  } else if (typeof key === 'string' && Object.hasOwn(PREF_FIELDS, key)) {
    await patch({ [PREF_FIELDS[key as keyof typeof PREF_FIELDS]]: value });
  } else {
    throw new Error(`unknown preference ${key}`);
  }
  return `${label} ${value ? 'on' : 'off'}`;
}

async function ping({ ip, name }: Args): Promise<string> {
  const result = (await api(
    `ping?ip=${encodeURIComponent(String(ip))}&type=disco`,
    'POST'
  )) as {
    Err?: string;
    LatencySeconds?: number;
    Endpoint?: string;
    DERPRegionCode?: string;
  };
  if (result.Err) {
    throw new Error(`Ping ${name}: ${result.Err}`);
  }
  const ms = Math.round((result.LatencySeconds ?? 0) * 1000);
  const path = result.Endpoint ? 'direct' : `via DERP ${result.DERPRegionCode}`;
  return `Ping ${name}: pong in ${ms} ms (${path})`;
}

/**
 * The file dialog is a normal window below the panel's layer, and a closed
 * panel drops its pending calls, so the service picks and sends.
 */
async function send({ ip, name }: Args): Promise<string | null> {
  const paths = await pick({ acceptLabel: 'Send', multiple: true });
  if (!paths) {
    return null;
  }
  await tailscale(['file', 'cp', ...paths, `${ip}:`]);
  remember(
    paths.map((path) => ({
      file: basename(path),
      meta: `Sent to ${name} · ${now()}`
    }))
  );
  return `Sent ${count(paths.length)} to ${name}`;
}

async function receive(): Promise<string | null> {
  const files = ((await api('files/')) ?? []) as { Name: string }[];
  if (files.length === 0) {
    return 'Taildrop: no files waiting';
  }
  let dir = get('downloads');
  if (!dir) {
    const picked = await pick({ acceptLabel: 'Save here', directory: true });
    if (!picked) {
      return null;
    }
    dir = picked[0];
    const error = set('downloads', dir);
    if (error) {
      console.warn(`tailscale: keeping the Taildrop folder: ${error.message}`);
    }
  }
  await tailscale(['file', 'get', '--conflict=rename', dir]);
  remember(
    files.map((file) => ({ file: file.Name, meta: `Received · ${now()}` }))
  );
  queueRefresh();
  return `Taildrop: ${count(files.length)} saved to ${dir}`;
}

async function pick(
  options: Parameters<typeof pickFiles>[0]
): Promise<string[] | null> {
  closePanel('main');
  const picked = await pickFiles(options);
  openPanel('main');
  if (picked !== null && 'message' in picked) {
    throw new Error(picked.message);
  }
  return picked as string[] | null;
}

async function tailscale(args: string[]): Promise<void> {
  const out = await process.run('tailscale', args);
  if (out.code !== 0) {
    throw new Error(
      out.stderr.trim() || `tailscale ${args[0]} ${args[1]} exited ${out.code}`
    );
  }
}

function remember(entries: Recent[]): void {
  const recent = (getState('recent') as Recent[] | null) ?? [];
  setState('recent', [...entries.reverse(), ...recent].slice(0, 5));
}

function now(): string {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function count(n: number): string {
  return n === 1 ? '1 file' : `${n} files`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
