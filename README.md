# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02)

One server, two client wires, and a real free model behind every answer.

The server answers the OpenAI Chat Completions and Anthropic Messages APIs, in JSON and in
server-sent events, and every completion it returns is a real call to one of OpenRouter's fourteen
free models, made through the grader's gateway on the trial's key. `GET /v1/models` answers in the
shape the request's auth header names: `Authorization: Bearer` gets the OpenAI list, `x-api-key` the
Anthropic one.

## Routing

The brief (`$MAKEFUN_PROMPT_FILE`) ships the free-model table with the house's published rating in
milli-points and a capability row (tools, vision, JSON mode, context length), plus the six prompt rows
in the order the client sends them. For each request the router:

1. takes the brief's requirements for the arriving prompt row (or reads them off the body when the
   brief has no row: `tools`, images, `response_format`), and keeps only free models whose published
   capabilities meet them (`tools`, `vision`, `json`, `min_context`);
2. orders those candidates by `rating_milli` best first, with the model id as the stable tie-break, so
   the best model that can serve the prompt is tried first rather than the first one in brief order;
3. dials the first candidate on the gateway's Chat Completions route. Every call asks for a whole
   answer, not an upstream stream, because the router has to read the prompt's token before it decides
   the answer is usable. The client still gets a stream when it asked for one: the completed answer is
   rendered into the OpenAI chunk sequence or the Anthropic event sequence.

### Refusals, cooldowns and failover

A gateway answer that is not a 2xx, a network/transport error, and a malformed or empty upstream body
are all refusals. A refused model is cooled down and the next candidate is tried.
Cooldowns are counted in gateway calls, never wall-clock seconds, so a replay makes the same choices
from the same answers:

- a `429` (rate limit) rests one logical call, so a later prompt may re-probe it;
- a network/transport error rests four calls;
- a 5xx or other 4xx rests two calls; each further refusal of the same model lengthens the rest.

A model that answers successfully clears its record. Models that are cooling down are skipped while a
non-cooling candidate remains; if every candidate is cooling, the best one is still used as a last
resort, because an unserved prompt scores nothing. One prompt makes at most six attempts. There is
deliberately no timeout on a gateway dial: a timeout is a wall-clock decision, so live and replay could
take different branches — the live pass moving on, the replay seeing the instant answer and staying on
the model. A slow call is bounded by the client's own 30 s per-answer timeout, and an awaited call never
blocks the event loop, so later prompts still run. The env's register and `/work` polls keep short local
aborts; those are not model calls and cannot change the scored request sequence.

### The token check

Each prompt carries a unique token such as `COMET-3884`, and the answer must carry it back. The router
reads the token from the request's messages and system prompt and checks the completed answer's text.
If a model's answer omits the token, that answer is kept as a last resort and the next candidate is
tried; only an answer that carries the token is returned while any candidate remains. The optional
`x-makefun-upstream-failures` trail is attached only to an answer that actually carries the token, so
it describes refusals this server really recovered from and never dresses up a reserve answer as a
served prompt.

### The wires

`POST /v1/chat/completions` passes the client's body to the gateway with `model` replaced by the dialled
free model id, an explicit `max_tokens` (the gateway refuses a request with no output cap) and
`stream: false`. The completed answer is returned as a `chat.completion` object, or rendered as
`chat.completion.chunk` frames with a finish chunk, a usage chunk and a final `[DONE]`.

`POST /v1/messages` translates the Anthropic body to Chat Completions first: the system prompt becomes a
system message, image blocks become `image_url` parts, `tool_use` blocks become `tool_calls`,
`tool_result` blocks become tool messages, tools and `tool_choice` are rewritten, and temperature,
top_p and stop sequences pass through. The answer is translated back to a Messages object, or to the
`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` /
`message_delta` / `message_stop` event order.

Every answer reports the dialled id in its `model` field, on every JSON answer and every streamed
chunk. The provider's own answer spells the same model without the gateway's `openrouter/` prefix; the
id this entry reports is the one it put in the gateway request, never a different one. Usage is a whole
input count of at least 0 and an output count of at least 1, and every stop reason is one the client's
wire accepts. Tool calls whose name the client did not declare are dropped before rendering.

### The catalog

The catalog is exactly the brief's fourteen free model ids, once each, with the brief's
`context_length`, under one `openrouter` provider whose `base_url` is OpenRouter's public endpoint
(never the gateway's trial-local address, which differs between a live pass and its replay).
`node main.ts --list` prints that document, and the register body carries the same object; both
`GET /v1/models` answers list the same ids in the wire's own shape.

## Run it

```sh
node main.ts            # a trial: reads MAKEFUN_PROMPT_FILE, registers, serves, exits when /work is done
node main.ts --list     # prints the catalog document it registers, byte for byte
```

Node 22's standard library alone; nothing is installed and relative imports carry their `.ts`
extension. A trial sets:

```sh
MAKEFUN_ENV_URL, MAKEFUN_PROMPT_FILE, OPENAI_BASE_URL, ANTHROPIC_BASE_URL,
OPENAI_API_KEY, ANTHROPIC_API_KEY
```

The server listens on `0.0.0.0` at an OS-chosen free port (never 8080), registers
`{"protocol_version": 1, "port": <port>, "catalog": <catalog>}` at `$MAKEFUN_ENV_URL/register`, and
polls `GET $MAKEFUN_ENV_URL/work` every 100 ms, exiting 0 when the env says done.

## Determinism

No wall clock is read into a gateway or env request and no unseeded randomness is used. The gateway
dial has no timeout, so a slow answer cannot make the live pass and its replay take different branches;
the only timers are the short aborts on `POST /register` and the `GET /work` poll, which are not model
calls. The route is a function of the brief, the request bodies and the gateway's answers; cooldowns are
counted in logical calls; model listings use a fixed `created` / `created_at`; the catalog's `base_url`
is the provider's public endpoint. Two runs that see the same answers make the same calls and leave the
same state export.

## Verify locally

The kit's mock harness takes `node run.mjs [KIT] [REPO] [TRIAL]` and defaults to
`../kit/free-model-aggregator-02-kit`, `../repo` and `trial-0`, so from `mock/`:

```sh
node run.mjs
node run.mjs ../kit/free-model-aggregator-02-kit ../repo trial-1
node run.mjs ../kit/free-model-aggregator-02-kit ../repo trial-2
```

Each run starts a mock gateway, the mock env, and this server, then drives the six practice prompts.
The kit also ships the real env and scorer; running them against a cassette-recording gateway is the
stronger check, and on the three practice instances it reports every prompt valid, every wire check
passed, catalog 100 and a byte-identical state export on a second run.

## License

MIT (see `LICENSE`).
