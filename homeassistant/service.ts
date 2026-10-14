import { fail, nextCall, reply, setState } from 'corona/plugin';
import type { Call, JsonValue } from 'corona/plugin';
import { get, nextChange, set } from 'corona/settings';
import * as secrets from 'corona/secrets';
import { WebSocket } from 'websocket';
import type { WebSocketSocket } from 'websocket';
import type { AsyncContext } from 'gpui-kit';

export type Status =
  | 'unconfigured'
  | 'connecting'
  | 'unreachable'
  | 'auth-failed'
  | 'connected';
export interface Entity {
  id: string;
  state: string;
  attributes: Record<string, JsonValue>;
}
/** What the views read from state `ha` */
export interface Snapshot {
  status: Status;
  error: string | null;
  /** The monitored entities by id, as far as Home Assistant reported them */
  entities: Record<string, Entity>;
}
/** An entity in the Manage entities list */
export interface Listed {
  id: string;
  name: string;
}

type Args = Record<string, JsonValue>;
interface Message {
  id?: number;
  type: string;
  [key: string]: JsonValue | undefined;
}
/** Subscribe_entities' compressed state: `s` state, `a` attributes */
interface Compressed {
  s?: string;
  a?: Record<string, JsonValue>;
}

let snapshot: Snapshot = { entities: {}, error: null, status: 'connecting' };
let session: Session | null = null;

function publish(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  setState('ha', snapshot);
}

/** Each answers with the line the panel shows, or a value */
const methods: Record<string, (args: Args) => Promise<JsonValue>> = {
  /** Every entity, for Manage entities: one `get_states`, not kept */
  browse: async () => {
    const states = (await live().request({ type: 'get_states' })) as Entity[] &
      { entity_id: string }[];
    return states
      .map((e) => {
        const raw = e as unknown as {
          entity_id: string;
          attributes: { friendly_name?: string };
        };
        return {
          id: raw.entity_id,
          name: raw.attributes.friendly_name ?? raw.entity_id
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  },
  call: async ({ domain, service, entity, data }) => {
    await live().request({
      domain,
      service,
      service_data: data ?? {},
      target: { entity_id: entity },
      type: 'call_service'
    });
    return null;
  },
  pin: async ({ id, on }) => {
    const pinned = get('entities').filter((x) => x !== id);
    const error = set('entities', on ? [...pinned, String(id)] : pinned);
    if (error) {
      throw new Error(error.message);
    }
    return null;
  }
};

export default async function main(cx: AsyncContext): Promise<void> {
  void connect(cx);
  void follow();
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
    reply(id, await handler((args ?? {}) as Args));
  } catch (error) {
    setState('msg', `✗ ${message(error)}`);
    fail(id, message(error));
  }
}

function live(): Session {
  if (!session) {
    throw new Error('not connected to Home Assistant');
  }
  return session;
}

/** Resolves on the next change to the URL or token; `connect` waits on it instead of retrying blindly */
let credentialsChanged: () => void = () => {};
async function nextCredentials(): Promise<void> {
  return new Promise((resolve) => (credentialsChanged = resolve));
}

/** Settings changes: new credentials reconnect, new pins resubscribe */
async function follow(): Promise<void> {
  while (true) {
    const change = await nextChange();
    if ('message' in change) {
      return;
    } // The service is stopping
    if (change.key === 'url' || change.key === 'token') {
      session?.close();
      credentialsChanged();
    } else if (change.key === 'entities' && 'value' in change) {
      void session
        ?.subscribe(change.value)
        .catch((error) => console.warn(`homeassistant: ${message(error)}`));
    }
  }
}

/**
 * Keeps one connection up. Waits for settings while unconfigured or the token
 * is refused; retries with a backoff (2 s to 2 min) while unreachable, sooner
 * when the settings change.
 */
async function connect(cx: AsyncContext): Promise<void> {
  let delay = 2000;
  while (true) {
    const changed = nextCredentials();
    const url = get('url').trim().replace(/\/+$/, '');
    const token = await secrets.get('token');
    if (!url || !token || typeof token !== 'string') {
      publish({ entities: {}, error: null, status: 'unconfigured' });
      await changed;
      continue;
    }
    publish({ error: null, status: 'connecting' });
    let retry = true;
    try {
      const socket = await WebSocket.connect(
        `${url.replace(/^http/, 'ws')}/api/websocket`
      );
      if (!(await authenticate(socket, token))) {
        void socket.close().catch(() => {});
        publish({ entities: {}, error: null, status: 'auth-failed' });
        retry = false;
      } else {
        delay = 2000;
        session = new Session(socket);
        publish({ error: null, status: 'connected' });
        await session.run(get('entities'));
      }
    } catch (error) {
      publish({ error: message(error), status: 'unreachable' });
    }
    session = null;
    if (retry) {
      if (snapshot.status === 'connected') {
        publish({ error: 'the connection closed', status: 'unreachable' });
      }
      await Promise.race([changed, cx.sleep(delay)]);
      delay = Math.min(delay * 2, 120_000);
    } else {
      await changed;
    }
  }
}

/** `auth_required`, then our token; true on `auth_ok` */
async function authenticate(
  socket: WebSocketSocket,
  token: string
): Promise<boolean> {
  const hello = JSON.parse(String(await socket.read())) as Message;
  if (hello.type !== 'auth_required') {
    throw new Error(`unexpected ${hello.type} from Home Assistant`);
  }
  await socket.write(JSON.stringify({ access_token: token, type: 'auth' }));
  const answer = JSON.parse(String(await socket.read())) as Message;
  return answer.type === 'auth_ok';
}

/** One authenticated connection: numbered requests, and the pinned entities' subscription */
class Session {
  declare socket: WebSocketSocket;
  declare next: number;
  declare pending: Map<
    number,
    { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
  >;
  /** The id of the running subscribe_entities */
  declare subscription: number | null;

  constructor(socket: WebSocketSocket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    this.subscription = null;
  }

  /** Reads until the connection closes */
  async run(pinned: string[]): Promise<void> {
    void this.subscribe(pinned).catch((error) =>
      setState('msg', `✗ ${message(error)}`)
    );
    try {
      while (true) {
        this.receive(JSON.parse(String(await this.socket.read())) as Message);
      }
    } finally {
      for (const { reject } of this.pending.values()) {
        reject(new Error('the connection to Home Assistant closed'));
      }
      this.pending.clear();
    }
  }

  receive(msg: Message): void {
    if (msg.type === 'result') {
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!waiter) {
        return;
      }
      if (msg.success) {
        waiter.resolve(msg.result ?? null);
      } else {
        waiter.reject(
          new Error(
            String(
              (msg.error as { message?: string })?.message ?? 'request failed'
            )
          )
        );
      }
    } else if (msg.type === 'event' && msg.id === this.subscription) {
      apply(
        msg.event as {
          a?: Record<string, Compressed>;
          c?: Record<string, { '+'?: Compressed; '-'?: { a?: string[] } }>;
          r?: string[];
        }
      );
    }
  }

  async request(msg: {
    type: string;
    [key: string]: JsonValue;
  }): Promise<JsonValue> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.socket
        .write(JSON.stringify({ ...msg, id }))
        .catch((error: unknown): void => {
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /** Swaps the subscription for one over `pinned`; its first event is their whole state */
  async subscribe(pinned: string[]): Promise<void> {
    if (this.subscription !== null) {
      const old = this.subscription;
      this.subscription = null;
      await this.request({
        subscription: old,
        type: 'unsubscribe_events'
      }).catch((): null => null);
    }
    publish({ entities: {} });
    if (pinned.length === 0) {
      return;
    }
    // The id is known before the answer, so no event slips past
    this.subscription = this.next;
    await this.request({ entity_ids: pinned, type: 'subscribe_entities' });
  }

  close(): void {
    void this.socket.close().catch(() => {});
  }
}

/** Applies a subscribe_entities event: `a` added, `c` changed (`+` set, `-` removed attributes), `r` removed */
function apply(event: {
  a?: Record<string, Compressed>;
  c?: Record<string, { '+'?: Compressed; '-'?: { a?: string[] } }>;
  r?: string[];
}): void {
  const entities = { ...snapshot.entities };
  for (const [id, e] of Object.entries(event.a ?? {})) {
    entities[id] = { attributes: e.a ?? {}, id, state: e.s ?? 'unknown' };
  }
  for (const [id, diff] of Object.entries(event.c ?? {})) {
    const now = entities[id] ?? { attributes: {}, id, state: 'unknown' };
    const attributes = { ...now.attributes, ...diff['+']?.a };
    for (const key of diff['-']?.a ?? []) {
      delete attributes[key];
    }
    entities[id] = { attributes, id, state: diff['+']?.s ?? now.state };
  }
  for (const id of event.r ?? []) {
    delete entities[id];
  }
  publish({ entities });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
