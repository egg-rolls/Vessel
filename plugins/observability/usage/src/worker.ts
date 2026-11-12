/**
 * Worker-thread entry: the plugin's read + aggregate work, off the host's event
 * loop.
 *
 * The main thread (index.ts) only parses the RPC and forwards a small query; this
 * thread owns the event store (byte offsets, first-line cache, LRU event cache),
 * the run index and the aggregation, and answers with a finished DTO plus the
 * coverage/metrics. Nothing is ever posted back except the answer, so no event
 * array crosses the thread boundary.
 *
 * Why a thread at all: reading ~125 MiB of session logs and folding 18k request
 * records takes a few hundred milliseconds. On the main thread that freezes every
 * other RPC, which is exactly why the old reader needed hard I/O caps that made
 * the totals silently partial. Off the main thread the caps can go away and a
 * range is simply complete (see ReadLimits in store.ts).
 *
 * Protocol (parent <-> here), one JSON object per message:
 *   { id, kind: 'init',  dataDir, settings }  ->  { id, ok: true }
 *   { id, kind: 'query', query: UsageQuery }  ->  { id, ok: true, outcome }
 *   { id, kind: 'reset' }                     ->  { id, ok: true }
 *   { id, kind: 'ping' }                      ->  { id, ok: true, worker: true }
 * Any failure answers { id, ok: false, error } so the caller can fall back.
 */
import { parentPort } from 'node:worker_threads';
import type { Settings } from './store.js';
import { type QueryOutcome, QueryRuntime, type UsageQuery } from './query.js';

interface InitMessage {
  id: number;
  kind: 'init';
  dataDir: string;
  settings: Settings;
}

interface QueryMessage {
  id: number;
  kind: 'query';
  query: UsageQuery;
}

interface SimpleMessage {
  id: number;
  kind: 'reset' | 'ping';
}

type Incoming = InitMessage | QueryMessage | SimpleMessage;

const runtime = new QueryRuntime();
const port = parentPort;

if (port === null) {
  // Imported outside a worker: nothing to serve. Fail loudly but harmlessly —
  // the plugin only loads this file through new Worker().
  process.stderr.write('[usage] worker.ts loaded outside a worker thread\n');
} else {
  port.on('message', (message: Incoming) => {
    void handle(message).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      port.postMessage({ id: message.id, ok: false, error: reason });
    });
  });
}

async function handle(message: Incoming): Promise<void> {
  if (port === null) return;
  switch (message.kind) {
    case 'init': {
      runtime.init(message.dataDir, message.settings);
      port.postMessage({ id: message.id, ok: true, worker: true });
      return;
    }
    case 'reset': {
      runtime.reset();
      port.postMessage({ id: message.id, ok: true, worker: true });
      return;
    }
    case 'ping': {
      port.postMessage({ id: message.id, ok: true, worker: true });
      return;
    }
    case 'query': {
      const outcome: QueryOutcome = await runtime.query(message.query);
      port.postMessage({ id: message.id, ok: true, outcome, worker: true });
      return;
    }
  }
}
