// free-model-aggregator-02: one server, two client wires, and a real free model behind every answer.
//
// A trial runs this file as `node main.ts` from the repository root on Node 22's standard library alone.
// The env is at $MAKEFUN_ENV_URL; every model call goes through the gateway at $OPENAI_BASE_URL on the
// trial's stand-in key. The brief at $MAKEFUN_PROMPT_FILE carries the fourteen free OpenRouter models
// (with the house's published rating and capabilities) and the six prompt rows, in the order the client
// sends them.
//
// Routing, in one sentence: for each request, keep the free models that meet the prompt's published
// requirements, order them by rating_milli best first, dial the best, and on a refusal or an answer that
// omits the prompt's token cool that model down against a logical call counter and move to the next.
//
// The entry:
//   1. listens on 0.0.0.0 at a free ephemeral port (never 8080, which the env owns on one layout);
//   2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version":1,"port":<port>,"catalog":<catalog>};
//   3. serves GET /v1/models in the shape the auth header names, POST /v1/chat/completions (OpenAI) and
//      POST /v1/messages (Anthropic), each in JSON or server-sent events as the request asks;
//   4. answers each prompt by dialling a free model on the gateway's Chat Completions route and returning
//      the gateway's answer in the client's wire, with the dialled model named on every answer and chunk;
//   5. polls GET $MAKEFUN_ENV_URL/work and exits 0 when the env says done.
//
// `node main.ts --list` prints the catalog document and exits 0 before any server starts; the register
// body's catalog is that same document, byte for byte.
//
// THE DETERMINISM RULE
//   Nothing that differs between two runs may reach a request. This file never reads the clock into a
//   gateway or env request and never draws a random number. The only clock reads are the local budgets
//   that bound a wedged call; the route itself is a function of the brief, the request bodies and the
//   gateway's answers. Cooldowns are counted in gateway calls, not seconds, so a replay makes the same
//   choices from the same answers.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { buildCatalog, freeModels, isRecord, meetsRequirement, readBrief } from './lib/brief.ts';
import type { Brief, CatalogReport, Json, ModelRow, Requirement } from './lib/brief.ts';
import {
  anthropicError,
  anthropicModelList,
  anthropicUpstreamBody,
  declaredToolNames,
  openAIError,
  openAIModelList,
  openAIUpstreamBody,
  parseUpstreamAnswer,
  refusalCode,
  renderAnthropicJson,
  renderAnthropicStream,
  renderOpenAIJson,
  renderOpenAIStream,
  shorthand,
  tokenOf,
} from './lib/wire.ts';
import type { FailureRow, ServedModel, UpstreamAnswer } from './lib/wire.ts';

/** The wire protocol version in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this entry reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * The per-attempt gateway timeout, in milliseconds, indexed by attempt number. It is a fixed schedule,
 * never a wall-clock budget: a live pass and its instant replay make the same attempt choices. The sum
 * is 28 s, inside the client's 30 s window, and fast refusals never spend their timeout.
 */
const CALL_TIMEOUTS_MS = [12_000, 8_000, 4_000, 2_000, 1_000, 1_000];
/** The most gateway calls one prompt may make, so a bad day cannot exhaust the trial's 60-call cap. */
const MAX_ATTEMPTS = CALL_TIMEOUTS_MS.length;
/** The most refusal rows the optional trail header may carry. */
const MAX_TRAIL_ROWS = 8;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's stand-in key; the gateway swaps it for the entrant's OpenRouter key, which never enters here. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief: Brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** The free models, each id once, in the brief's order; the router re-orders per request. */
const free = freeModels(brief);
const modelById = new Map(free.map((model) => [model.id, model]));
/** What GET /v1/models lists: exactly the catalog's models, each id once. */
const servedModels: ServedModel[] = catalog.providers.flatMap((provider) =>
  provider.models.map((model) => ({
    id: model.id,
    provider: 'openrouter',
    display_name: modelById.get(model.id)?.display_name ?? model.id,
  })),
);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** The gateway's Chat Completions route. OPENAI_BASE_URL is the `…/v1` root on the trial network. */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

// ---------------------------------------------------------------------------------------------
// Routing: the best published rating that meets the prompt's requirements, best first.
// ---------------------------------------------------------------------------------------------

/** Every free model that meets the requirements, best published rating first, id as the stable tie-break. */
function candidatesFor(requires: Requirement): ModelRow[] {
  return free
    .filter((model) => meetsRequirement(requires, model))
    .sort((a, b) => b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Cooldowns, counted in gateway calls so a replay makes the same choices.
// ---------------------------------------------------------------------------------------------

/** Model id -> the first logical call number at which it is available again (exclusive bound). */
const coolingUntil = new Map<string, number>();
/** Model id -> how many refusals it has produced; a second refusal cools it down for longer. */
const failureCounts = new Map<string, number>();
/** The logical call counter. It never depends on the clock. */
let gatewayCalls = 0;

function isCooling(modelId: string): boolean {
  return (coolingUntil.get(modelId) ?? 0) > gatewayCalls;
}

/** Mark a refused call: the model is skipped while a better-behaved candidate remains. */
function markRefusal(modelId: string, status: number): void {
  const count = (failureCounts.get(modelId) ?? 0) + 1;
  failureCounts.set(modelId, count);
  // A rate limit (429) is cheap to re-probe on a later prompt: it rests one logical call. A wedged
  // call (timeout or network error) costs the full 12 s, so it rests longer. A 5xx rests in between.
  // Each further refusal of the same model lengthens the rest, up to a bounded extra.
  const base = status === 429 ? 1 : status === 0 ? 4 : 2;
  const extra = base + Math.min(count - 1, 3);
  coolingUntil.set(modelId, gatewayCalls + extra);
}

/** A successful call clears the model's record: it is behaving again. */
function markSuccess(modelId: string): void {
  coolingUntil.delete(modelId);
  failureCounts.delete(modelId);
}

/** An answer that omitted the prompt's token is kept as a last resort, and the model rests one call. */
function markTokenMiss(modelId: string): void {
  coolingUntil.set(modelId, gatewayCalls + 1);
}

// ---------------------------------------------------------------------------------------------
// Requirements: the brief's row for the arriving prompt, or the body's own shape when there is none.
// ---------------------------------------------------------------------------------------------

function requirementsFromBody(body: Json): Requirement {
  const requires: Requirement = {};
  if (Array.isArray(body.tools) && body.tools.length > 0) requires.tools = true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) requires.vision = true;
    }
  }
  if (isRecord(body.response_format)) {
    const type = body.response_format.type;
    if (type === 'json_object' || type === 'json_schema') requires.json = true;
  }
  return requires;
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const row = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (row !== undefined) return row.requires;
  return requirementsFromBody(body);
}

// ---------------------------------------------------------------------------------------------
// One prompt: dial candidates until one answer carries the token (or keep the best answer as a fallback).
// ---------------------------------------------------------------------------------------------

type ServedResult =
  | { kind: 'answer'; model: string; answer: UpstreamAnswer; trail: FailureRow[]; verified: boolean }
  | { kind: 'none'; status: number; message: string };

interface Prefix {
  model: string;
  answer: UpstreamAnswer;
}

async function serve(
  wire: 'openai' | 'anthropic',
  body: Json,
  requires: Requirement,
  token: string | null,
  declared: readonly string[],
): Promise<ServedResult> {
  const all = candidatesFor(requires);
  if (all.length === 0) {
    return { kind: 'none', status: 503, message: 'no free model in the brief meets this request' };
  }

  const ready = all.filter((model) => !isCooling(model.id));
  const resting = all.filter((model) => isCooling(model.id));
  const tried = new Set<string>();
  const trail: FailureRow[] = [];
  let success: Prefix | null = null;
  let fallback: Prefix | null = null;
  let lastStatus = 504;
  let lastText = 'no candidate answered before the attempt cap';
  let attempts = 0;

  const build = (modelId: string): Json =>
    wire === 'openai' ? openAIUpstreamBody(body, modelId) : anthropicUpstreamBody(body, modelId);

  const attempt = async (model: ModelRow): Promise<void> => {
    if (tried.has(model.id) || attempts >= MAX_ATTEMPTS) return;
    tried.add(model.id);
    attempts += 1;
    gatewayCalls += 1;
    const timeout = CALL_TIMEOUTS_MS[Math.min(attempts - 1, CALL_TIMEOUTS_MS.length - 1)];

    let upstream: Response;
    try {
      upstream = await fetch(chatCompletionsUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` },
        body: JSON.stringify(build(model.id)),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      markRefusal(model.id, 0);
      trail.push({ status: 504, code: 'timeout_or_network', model: model.id });
      lastStatus = 504;
      lastText = (err as Error).message;
      return;
    }

    if (!upstream.ok) {
      let text = '';
      try {
        text = await upstream.text();
      } catch {
        text = '';
      }
      markRefusal(model.id, upstream.status);
      trail.push({ status: upstream.status, code: refusalCode(upstream.status, text), model: model.id });
      lastStatus = upstream.status;
      lastText = text;
      return;
    }

    let raw: unknown;
    try {
      raw = await upstream.json();
    } catch (err) {
      markRefusal(model.id, 502);
      trail.push({ status: 502, code: 'invalid_upstream_json', model: model.id });
      lastStatus = 502;
      lastText = (err as Error).message;
      return;
    }
    if (!isRecord(raw)) {
      markRefusal(model.id, 502);
      trail.push({ status: 502, code: 'invalid_upstream_json', model: model.id });
      lastStatus = 502;
      lastText = 'the gateway answer is not one JSON object';
      return;
    }

    const answer = parseUpstreamAnswer(raw, model.id, declared);
    if (!answer.valid) {
      markRefusal(model.id, 502);
      trail.push({ status: 502, code: 'empty_completion', model: model.id });
      lastStatus = 502;
      lastText = 'the gateway answer holds no assistant message';
      return;
    }

    markSuccess(model.id);
    if (token === null || answer.text.includes(token)) {
      success = { model: model.id, answer };
      return;
    }
    // The model answered, but not with the prompt's token: keep the best such answer in reserve and
    // try the next candidate, because a prompt whose answer omits its token scores nothing.
    markTokenMiss(model.id);
    if (fallback === null) fallback = { model: model.id, answer };
  };

  // First pass: the models that are not cooling down, best rating first.
  for (const model of ready) {
    if (success !== null) break;
    await attempt(model);
  }

  // Last resort: models that were cooling down at the start of this prompt, best rating first.
  if (success === null) {
    for (const model of resting) {
      if (success !== null) break;
      await attempt(model);
    }
  }

  if (success !== null) {
    const served = success as Prefix;
    return { kind: 'answer', model: served.model, answer: served.answer, trail, verified: true };
  }
  if (fallback !== null) {
    const kept = fallback as Prefix;
    return { kind: 'answer', model: kept.model, answer: kept.answer, trail: [], verified: false };
  }
  return { kind: 'none', status: lastStatus, message: shorthand(lastText, 500) };
}

/**
 * The optional refusal trail, attached only to an answer that actually carries the prompt's token. The
 * header is how the failover column sees a refusal this server recovered from; a reserve answer that
 * did not carry the token is not a served prompt, so it is not reported as a recovered failover.
 */
function trailHeaders(result: { trail: FailureRow[]; verified: boolean }): Record<string, string> {
  if (!result.verified || result.trail.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(result.trail.slice(0, MAX_TRAIL_ROWS)) };
}

// ---------------------------------------------------------------------------------------------
// HTTP: body reading, responses, and the three scored routes.
// ---------------------------------------------------------------------------------------------

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  status: number,
  type: string,
  message: string,
): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(servedModels));
  else sendJson(res, 200, openAIModelList(servedModels));
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  }
  const requires = requirementsFor(body);
  const stream = body.stream === true;
  const token = tokenOf(body);
  const declared = declaredToolNames('openai', body);
  const result = await serve('openai', body, requires, token, declared);
  if (result.kind === 'none') {
    return sendError(res, 'openai', result.status, 'upstream_error', result.message);
  }
  const extra = trailHeaders(result);
  if (!stream) {
    return sendJson(res, 200, renderOpenAIJson(result.answer, result.model), extra);
  }
  const text = renderOpenAIStream(result.answer, result.model);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...extra,
  });
  res.end(text);
}

/** POST /v1/messages: an Anthropic-shaped client, translated to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  }
  const requires = requirementsFor(body);
  const stream = body.stream === true;
  const token = tokenOf(body);
  const declared = declaredToolNames('anthropic', body);
  const result = await serve('anthropic', body, requires, token, declared);
  if (result.kind === 'none') {
    return sendError(res, 'anthropic', result.status, 'api_error', result.message);
  }
  const extra = trailHeaders(result);
  if (!stream) {
    return sendJson(res, 200, renderAnthropicJson(result.answer, result.model), extra);
  }
  const text = renderAnthropicStream(result.answer, result.model);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...extra,
  });
  res.end(text);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(
    res,
    url.pathname === '/v1/messages' ? 'anthropic' : 'openai',
    404,
    'not_found',
    `no route ${req.method ?? ''} ${url.pathname}`,
  );
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${shorthand(await res.text(), 500)}`);
  }
  const reply: unknown = await res.json().catch(() => null);
  if (isRecord(reply) && typeof reply.requests === 'number') {
    log(`registered: the trial holds ${reply.requests} prompts`);
  }
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. Wait for the write callback so a non-file stdout cannot lose the tail.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        sendError(
          res,
          req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai',
          500,
          'internal_error',
          'the server failed to answer',
        );
      } else {
        res.end();
      }
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range does not pick it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels.length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
