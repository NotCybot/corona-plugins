import {
  type Call,
  type JsonValue,
  fail,
  nextCall,
  reply
} from 'corona/plugin';
import { notify } from 'corona/notifications';
import process from 'process';

/** What `call(method)` in a view and `corona ipc plugin positron <method>` reach */
const methods: Record<string, () => Promise<JsonValue>> = {
  hide: async () => run('hide'),
  show: async () => run('show'),
  toggle: async () => run('toggle')
};

export default async function main(): Promise<void> {
  while (true) {
    const call = await nextCall();
    if ('message' in call) {
      break;
    } // The service is stopping
    void answer(call);
  }
}

async function answer({ id, method }: Call): Promise<void> {
  const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (!handler) {
    fail(id, `unknown method ${method}`);
    return;
  }
  try {
    reply(id, await handler());
  } catch (error) {
    fail(id, error instanceof Error ? error.message : String(error));
  }
}

/** `positron ipc <action>`; positron has to be running, it is not started here */
async function run(action: string): Promise<JsonValue> {
  try {
    const out = await process.run('positron', ['ipc', action]);
    if (out.code === 0) {
      return null;
    }
    throw new Error(out.stderr.trim() || `positron exited ${out.code}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void notify({
      body: `Could not reach positron, is it running?\n${detail}`,
      summary: 'Notes'
    });
    throw error;
  }
}
