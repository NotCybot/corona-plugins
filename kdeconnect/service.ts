import { nextCall, reply, fail, getState, setState } from "corona/plugin";
import type { Call, JsonValue } from "corona/plugin";
import { call as dbusCall, getAll, nameHasOwner, setProperty, subscribe, nextSignal } from "corona/dbus";
import type { Rule } from "corona/dbus";
import { pickFiles } from "corona/desktop";
import { closePanel, openPanel } from "corona/surface";
import { get, set } from "corona/settings";
import process from "process";
import type { ChildProcess } from "process";

const KC = "org.kde.kdeconnect";
const ROOT = "/modules/kdeconnect";
const IFACE = "org.kde.kdeconnect.device";

export type Media = {
  title: string;
  artist: string;
  playing: boolean;
  canSeek: boolean;
  /** Milliseconds */
  length: number;
  position: number;
  /** `Date.now()` when `position` was read, to move it on while playing */
  at: number;
};
export type Device = {
  id: string;
  name: string;
  type: string;
  reachable: boolean;
  paired: boolean;
  /** The phone asks to pair */
  pairRequestedByPeer: boolean;
  /** This computer asked to pair */
  pairRequested: boolean;
  address: string | null;
  battery: { charge: number; charging: boolean } | null;
  network: { type: string; strength: number } | null;
  /** Media volume, 0–100; null without the mprisremote plugin */
  volume: number | null;
  media: Media | null;
};
/** What the views read from state `kc` */
export type Snapshot = { running: boolean; devices: Device[] };
/** State `cast`: the adb serial and whether scrcpy runs, by device id */
export type Cast = { serial: string | null; casting: boolean };
export type CastOptions = { res: number; br: number; fps: number; record: boolean; screenOff: boolean };

type Args = { [key: string]: JsonValue };

/** Each answers with the line the panel shows */
const methods: Record<string, (args: Args) => Promise<string | null>> = {
  refresh: async () => {
    await refresh();
    return null;
  },
  ring: async ({ id }) => {
    await plugin(id, "findmyphone", "ring");
    return "Ringing the phone";
  },
  ping: async ({ id }) => {
    await plugin(id, "ping", "sendPing");
    return "Ping sent";
  },
  browse: async ({ id }) => {
    const ok = await plugin(id, "sftp", "startBrowsing");
    if (ok === false) throw new Error(String(await plugin(id, "sftp", "getMountError")) || "could not mount the phone");
    return "Opening the phone's files…";
  },
  clipboard: async ({ id }) => {
    await plugin(id, "clipboard", "sendClipboard");
    return "Clipboard sent";
  },
  share,
  volume: async ({ id, value }) => {
    await mpris(id, "volume", Math.round(Number(value)));
    return null;
  },
  mute,
  media: async ({ id, action }) => {
    await plugin(id, "mprisremote", "sendAction", [String(action)]);
    return null;
  },
  seek: async ({ id, ms }) => {
    await mpris(id, "position", Math.round(Number(ms)));
    return null;
  },
  sms: async ({ id, number, text }) => {
    // ConversationAddress is a struct of one string, in a variant
    await plugin(id, "sms", "sendSms", [[{ $type: "(s)", value: [String(number)] }], String(text), []], "avsav");
    return `Message sent to ${number}`;
  },
  pair: async ({ id }) => {
    await device(id, "requestPairing");
    return "Pairing requested; confirm on the phone";
  },
  acceptPairing: async ({ id }) => {
    await device(id, "acceptPairing");
    return "Paired";
  },
  cancelPairing: async ({ id }) => {
    await device(id, "cancelPairing");
    return null;
  },
  unpair: async ({ id }) => {
    await device(id, "unpair");
    return "Unpaired";
  },
  adbStatus,
  adbPair,
  adbConnect,
  adbDisconnect,
  cast,
  stopCast: async ({ id }) => {
    casts.get(String(id))?.kill();
    return null;
  },
};

export default async function main(): Promise<void> {
  void watch({ bus: "session", sender: KC, pathNamespace: ROOT });
  // kdeconnectd starting or stopping
  void watch({ bus: "session", sender: "org.freedesktop.DBus", member: "NameOwnerChanged", arg0: KC });
  queueRefresh();
  while (true) {
    const call = await nextCall();
    if ("message" in call) break; // the service is stopping
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
    // also through state: a call that outlives a closed panel still reaches the next one
    if (line) setState("msg", line);
    reply(id, line);
  } catch (error) {
    setState("msg", `✗ ${message(error)}`);
    fail(id, message(error));
  }
}

/** Every signal `rule` matches (property changes, devices coming and going) refreshes the snapshot */
async function watch(rule: Rule): Promise<void> {
  try {
    const id = ok(await subscribe(rule));
    while (ok(await nextSignal(id))) queueRefresh();
  } catch (error) {
    console.warn(`kdeconnect: watching ${rule.sender}: ${message(error)}`);
  }
}

let refreshing: Promise<void> | null = null;
let again = false;

/** Coalesces a burst of signals into one refresh, and one more after it */
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
    if (!ok(await nameHasOwner("session", KC))) {
      setState("kc", { running: false, devices: [] });
      return;
    }
    const ids = ok(
      await dbusCall({
        bus: "session",
        dest: KC,
        path: ROOT,
        iface: "org.kde.kdeconnect.daemon",
        method: "devices",
        args: [false, false],
        signature: "bb",
      }),
    ) as string[];
    const devices = (await Promise.all(ids.map(read))).filter((d): d is Device => d !== null);
    devices.sort((a, b) => Number(b.paired) - Number(a.paired) || Number(b.reachable) - Number(a.reachable));
    setState("kc", { running: true, devices });
  } catch (error) {
    console.warn(`kdeconnect: refresh: ${message(error)}`);
  }
}

async function read(id: string): Promise<Device | null> {
  const props = (await getAll({ bus: "session", dest: KC, path: path(id), iface: IFACE })) as Record<string, JsonValue>;
  if ("message" in props) return null; // gone meanwhile
  const reachable = props.isReachable === true;
  const paired = props.isPaired === true;
  const live = reachable && paired;
  const [battery, network, media] = live
    ? await Promise.all([props_(id, "battery"), props_(id, "connectivity_report"), props_(id, "mprisremote")])
    : [null, null, null];
  const addresses = (props.reachableAddresses as string[] | null) ?? [];
  return {
    id,
    name: String(props.name),
    type: String(props.type),
    reachable,
    paired,
    pairRequestedByPeer: props.isPairRequestedByPeer === true,
    pairRequested: props.isPairRequested === true,
    address: addresses[0] ?? null,
    battery:
      battery && Number(battery.charge) >= 0
        ? { charge: Number(battery.charge), charging: battery.isCharging === true }
        : null,
    network:
      network && network.cellularNetworkType
        ? { type: String(network.cellularNetworkType), strength: Number(network.cellularNetworkStrength) }
        : null,
    volume: media ? Number(media.volume) : null,
    media:
      media && media.player
        ? {
            title: String(media.title),
            artist: String(media.artist),
            playing: media.isPlaying === true,
            canSeek: media.canSeek === true,
            length: Number(media.length),
            position: Number(media.position),
            at: Date.now(),
          }
        : null,
  };
}

/** Every property of a device plugin, null when the phone has it off */
async function props_(id: string, name: string): Promise<Record<string, JsonValue> | null> {
  const props = await getAll({
    bus: "session",
    dest: KC,
    path: `${path(id)}/${name}`,
    iface: `${IFACE}.${name}`,
  });
  return props && typeof props === "object" && !("message" in props) ? (props as Record<string, JsonValue>) : null;
}

function path(id: JsonValue): string {
  return `${ROOT}/devices/${String(id)}`;
}

async function device(id: JsonValue, method: string): Promise<JsonValue> {
  const answer = ok(await dbusCall({ bus: "session", dest: KC, path: path(id), iface: IFACE, method }));
  queueRefresh();
  return answer;
}

async function plugin(id: JsonValue, name: string, method: string, args?: JsonValue[], signature?: string): Promise<JsonValue> {
  const call = { bus: "session" as const, dest: KC, path: `${path(id)}/${name}`, iface: `${IFACE}.${name}`, method, args };
  return ok(await dbusCall(signature ? { ...call, signature } : call));
}

async function mpris(id: JsonValue, name: string, value: number): Promise<void> {
  ok(
    await setProperty({
      bus: "session",
      dest: KC,
      path: `${path(id)}/mprisremote`,
      iface: `${IFACE}.mprisremote`,
      name,
      value,
      signature: "i",
    }),
  );
}

/** Mutes to 0 and back to the volume before, kept per device in state `unmute` */
async function mute({ id }: Args): Promise<string | null> {
  const dev = ((getState("kc") as Snapshot | null)?.devices ?? []).find((d) => d.id === id);
  const unmute = (getState("unmute") as Record<string, number> | null) ?? {};
  const volume = dev?.volume ?? 0;
  if (volume > 0) {
    setState("unmute", { ...unmute, [String(id)]: volume });
    await mpris(id, "volume", 0);
  } else {
    await mpris(id, "volume", unmute[String(id)] || 50);
  }
  return null;
}

/**
 * The file dialog is a normal window below the panel's layer, and a closed
 * panel drops its pending calls, so the service picks.
 */
async function share({ id }: Args): Promise<string | null> {
  const paths = await pick({ multiple: true, acceptLabel: "Share" });
  if (!paths) return null;
  await plugin(id, "share", "shareUrls", [paths.map((p) => `file://${encodeURI(p)}`)], "as");
  return paths.length === 1 ? "Sharing 1 file" : `Sharing ${paths.length} files`;
}

async function pick(options: Parameters<typeof pickFiles>[0]): Promise<string[] | null> {
  closePanel("main");
  const picked = await pickFiles(options);
  openPanel("main");
  if (picked !== null && "message" in picked) throw new Error(picked.message);
  return picked as string[] | null;
}

// ---- casting: adb over Wi-Fi, scrcpy for the window ----

/** Answers with adb's output, failing on a non-zero exit or a "failed" line (adb exits 0 on those) */
async function adb(args: string[]): Promise<string> {
  const out = await process.run("adb", args);
  const text = `${out.stdout}${out.stderr}`.trim();
  if (out.code !== 0 || /^(failed|error)/im.test(text)) throw new Error(text || `adb ${args[0]} exited ${out.code}`);
  return text;
}

function setCast(id: JsonValue, patch: Partial<Cast>): void {
  const all = (getState("cast") as Record<string, Cast> | null) ?? {};
  const now = all[String(id)] ?? { serial: null, casting: false };
  setState("cast", { ...all, [String(id)]: { ...now, ...patch } });
}

/** The adb serial already connected for the phone's address; asked when the panel opens */
async function adbStatus({ id, address }: Args): Promise<null> {
  const out = await adb(["devices"]);
  const serial =
    out
      .split("\n")
      .map((line) => line.split(/\s+/))
      .find(([name, state]) => state === "device" && address && name.startsWith(`${address}:`))?.[0] ?? null;
  setCast(id, { serial });
  return null;
}

async function adbPair({ address, pin }: Args): Promise<string> {
  await adb(["pair", String(address), String(pin)]);
  return "Paired with wireless debugging; now connect";
}

async function adbConnect({ id, address }: Args): Promise<string> {
  const out = await adb(["connect", String(address)]);
  if (!/connected to/.test(out)) throw new Error(out);
  setCast(id, { serial: String(address) });
  return `ADB connected to ${address}`;
}

async function adbDisconnect({ id, serial }: Args): Promise<string> {
  casts.get(String(id))?.kill();
  await adb(["disconnect", String(serial)]);
  setCast(id, { serial: null });
  return "ADB disconnected";
}

const casts = new Map<string, ChildProcess>();

async function cast({ id, serial, options }: Args): Promise<string | null> {
  if (casts.has(String(id))) throw new Error("already casting");
  const o = options as CastOptions;
  const args = [
    `--serial=${serial}`,
    `--max-size=${o.res}`,
    `--video-bit-rate=${o.br}M`,
    `--max-fps=${o.fps}`,
  ];
  if (o.screenOff) args.push("--turn-screen-off");
  if (o.record) {
    let dir = get("recordings");
    if (!dir) {
      const picked = await pick({ directory: true, acceptLabel: "Save recordings here" });
      if (!picked) return null;
      dir = picked[0];
      const error = set("recordings", dir);
      if (error) console.warn(`kdeconnect: keeping the recordings folder: ${error.message}`);
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    args.push(`--record=${dir}/phone-${stamp}.mp4`);
  }
  const child = process.spawn("scrcpy", args, { stdout: "ignore" });
  casts.set(String(id), child);
  setCast(id, { casting: true });
  void (async () => {
    // the last stderr line says why scrcpy stopped
    let last: string | null = null;
    for (let line = await child.readErrLine(); line !== null; line = await child.readErrLine()) last = line;
    const status = await child.wait();
    casts.delete(String(id));
    setCast(id, { casting: false });
    if (status.code) setState("msg", `✗ scrcpy: ${last ?? `exited ${status.code}`}`);
  })();
  return "Casting";
}

/** `value` without its failure, which is thrown */
function ok<T>(value: T): Exclude<T, { message: string }> {
  if (value && typeof value === "object" && !Array.isArray(value) && "message" in value) {
    throw new Error(String((value as { message: unknown }).message));
  }
  return value as Exclude<T, { message: string }>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
