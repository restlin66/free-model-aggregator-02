# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02)

One server, two client wires, and a real free model behind every answer.

The server answers both the OpenAI Chat Completions and the Anthropic Messages API, in JSON and in
server-sent events, and every completion it returns is a real call to one of OpenRouter's free models,
made through the grader's gateway on the trial's key. `GET /v1/models` answers in the shape the request's
auth header names: `Authorization: Bearer` gets the OpenAI list, `x-api-key` the Anthropic one.

## Routing

The brief ships each free model with a published rating in milli-points and a capability row (tools,
vision, JSON mode, context length). For every request the server:

1. keeps the free models whose capabilities meet the request's requirements;
2. orders them by `rating_milli`, best first, so a prompt is served by the best model that can serve it;
3. dials the first, and on a refusal (4xx/5xx or a timeout) records a cooldown against a logical call
   counter and moves to the next one — never calling a model that is cooling down;
4. checks that the prompt's token came back in the answer. A answer that leaves the token out is kept as
   a last resort and the next model is tried, because a prompt only scores when its own answer carries it.

Cooldowns are counted in gateway calls rather than wall-clock seconds, so the whole route is a function
of the requests and the gateway's answers: a replay makes the same choices.

## Run it

```sh
node main.ts            # a trial: reads MAKEFUN_PROMPT_FILE, registers, serves, exits when /work is done
node main.ts --list     # prints the catalog document it registers, byte for byte
```

Node 22's standard library alone; nothing is installed.

## License

MIT
