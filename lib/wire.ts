// The two client wires, the one upstream wire, and the answer translation.
//
// Every prompt is dialled on the gateway's OpenAI Chat Completions route, streamed or not. A client that
// asked for server-sent events still gets server-sent events back; the completed answer is rendered into
// the OpenAI chunk sequence or the Anthropic event sequence. Doing the check on a whole answer before it
// is rendered is what lets the router see the prompt's token and fail over when a model omits it.
//
// The house records every gateway call and credits a prompt only when the provider's own answer body
// carries the prompt's token. The `model` field this entry reports must therefore be the id it dialled,
// on every JSON answer and every streamed chunk; `render*` takes that id as an argument and never makes
// one up.
//
// Everything here is a pure function of its arguments: no clock, no randomness, so the same request and
// the same gateway answer give the same bytes on a replay.

import { isRecord } from './brief.ts';
import type { Json } from './brief.ts';

/** One model the entry serves, as `GET /v1/models` lists it. */
export interface ServedModel {
  id: string;
  provider: string;
  display_name: string;
}

/** One refusal row of the optional `x-makefun-upstream-failures` trail. */
export interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/** A tool call the model asked for, already filtered to tools the client declared. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** The token counts a wire answer reports. Input is at least 0; output is at least 1. */
export interface AnswerUsage {
  input: number;
  output: number;
}

/** A completed Chat Completions answer, normalised for either client wire. */
export interface UpstreamAnswer {
  valid: boolean;
  id: string;
  created: number;
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: AnswerUsage;
}

/** A fixed epoch second for every listed model's `created`: nothing in a listing reads the clock. */
const FIXED_OPENAI_CREATED = 1767225600;
/** A fixed instant for every listed model's `created_at`. */
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';
/** The default output cap when a client sends none. The gateway refuses a request with no cap. */
const DEFAULT_MAX_TOKENS = 1024;
/** The gateway refuses an output cap over this. */
const MAX_MAX_TOKENS = 8192;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The text of a string, or the concatenated `text` members of a block array. */
export function textOfContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  let out = '';
  for (const block of value) {
    if (typeof block === 'string') out += block;
    else if (isRecord(block) && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/** The text of a tool_result block's content. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOfContent(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** An Anthropic image block as an OpenAI image_url content part, or null for another block. */
function imagePart(block: Json): Json | null {
  if (!isRecord(block.source)) return null;
  const source = block.source;
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** The output cap a request asks for, clamped to what the gateway accepts. */
export function outputCapOf(body: Json): number {
  const raw = typeof body.max_tokens === 'number'
    ? body.max_tokens
    : typeof body.max_completion_tokens === 'number'
      ? body.max_completion_tokens
      : typeof body.max_output_tokens === 'number'
        ? body.max_output_tokens
        : null;
  if (raw === null || !Number.isFinite(raw)) return DEFAULT_MAX_TOKENS;
  return Math.max(1, Math.min(MAX_MAX_TOKENS, Math.floor(raw)));
}

/**
 * An OpenAI Chat Completions request as the gateway receives it: the client's messages, system prompt,
 * tools, JSON mode, temperature and cap pass through; `model` names the free model this entry dialled;
 * `stream` is false because the entry asks for the whole answer and renders the client's stream itself.
 * `stream_options` is removed (it is only meaningful on a streamed upstream call) and the output cap is
 * made explicit, since the gateway refuses a request with none.
 */
export function openAIUpstreamBody(body: Json, model: string): Json {
  const out: Json = { ...body, model, stream: false, max_tokens: outputCapOf(body) };
  delete out.stream_options;
  delete out.max_completion_tokens;
  delete out.max_output_tokens;
  return out;
}

/** One tool definition as an OpenAI tool. */
function openAIToolOf(value: unknown): Json | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return {
    type: 'function',
    function: {
      name: value.name,
      description: typeof value.description === 'string' ? value.description : '',
      parameters: isRecord(value.input_schema) ? value.input_schema : { type: 'object', properties: {} },
    },
  };
}

/**
 * An Anthropic Messages request translated into the Chat Completions body the gateway dials: the system
 * prompt becomes a system message, image blocks become image_url parts, tool_use blocks become
 * tool_calls, tool_result blocks become tool messages, tools and tool_choice are rewritten, the stop
 * sequences, temperature and top_p pass through, and the output cap is made explicit.
 */
export function anthropicUpstreamBody(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOfContent(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });

  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOfContent(content);
      const message: Json = { role: 'assistant', content: text !== '' ? text : null };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      messages.push(message);
      continue;
    }

    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: toolResultText(block.content),
        });
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'image') {
        const part = imagePart(block);
        if (part !== null) parts.push(part);
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }

  const out: Json = { model, messages, max_tokens: outputCapOf(body), stream: false };
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((value) => {
      const tool = openAIToolOf(value);
      return tool === null ? [] : [tool];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'none') out.tool_choice = 'none';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  return out;
}

/** The tool names a client declared, as its own wire spells them. */
export function declaredToolNames(wire: 'openai' | 'anthropic', body: Json): string[] {
  if (!Array.isArray(body.tools)) return [];
  const names: string[] = [];
  for (const tool of body.tools) {
    if (!isRecord(tool)) continue;
    if (wire === 'openai') {
      if (isRecord(tool.function) && typeof tool.function.name === 'string' && tool.function.name !== '') {
        names.push(tool.function.name);
      }
    } else if (typeof tool.name === 'string' && tool.name !== '') {
      names.push(tool.name);
    }
  }
  return names;
}

/** The unique token a prompt carries, read from its messages and system prompt. */
export function tokenOf(body: Json): string | null {
  const text = JSON.stringify({ messages: body.messages ?? [], system: body.system ?? '' });
  const match = /\b[A-Z]{2,}-\d{4}\b/.exec(text);
  return match === null ? null : match[0];
}

/** The normalised OpenAI stop reason: only reasons the Chat Completions wire accepts. */
function finishReasonOf(value: unknown, hasToolCalls: boolean): string {
  if (value === 'length') return 'length';
  if (value === 'content_filter') return 'content_filter';
  if (hasToolCalls) return 'tool_calls';
  return 'stop';
}

/** Whole token counts for either wire. The output count is never below 1, as the wire checks require. */
function usageOf(raw: unknown, text: string): AnswerUsage {
  const usage = isRecord(raw) ? raw : {};
  const input = Math.max(0, Math.floor(numberOr(usage.prompt_tokens ?? usage.input_tokens, 0)));
  const reported = Math.floor(numberOr(usage.completion_tokens ?? usage.output_tokens, 0));
  const output = reported >= 1 ? reported : Math.max(1, Math.ceil(text.length / 4));
  return { input, output };
}

/** The Anthropic stop reason that corresponds to a normalised OpenAI finish reason. */
export function anthropicStopReason(finishReason: string): string {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** A tool call's argument string as an object, or {} when it is not one. */
function argumentsOf(value: string): Json {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A completed Chat Completions answer as the normalised form both renderers use. Tool calls whose name
 * the client did not declare are dropped: the wire check refuses an undeclared tool name, and a model
 * that answered by calling a tool can be failed over instead.
 */
export function parseUpstreamAnswer(raw: Json, dialedId: string, declared: readonly string[]): UpstreamAnswer {
  const empty: UpstreamAnswer = {
    valid: false,
    id: 'chatcmpl-aggregate',
    created: 0,
    text: '',
    toolCalls: [],
    finishReason: 'stop',
    usage: { input: 0, output: 1 },
  };
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  if (choices.length === 0) return empty;
  const choice = isRecord(choices[0]) ? choices[0] : null;
  if (choice === null) return empty;
  const message = isRecord(choice.message) ? choice.message : null;
  if (message === null) return empty;

  const text = typeof message.content === 'string' ? message.content : textOfContent(message.content);
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const rawCall of message.tool_calls) {
      if (!isRecord(rawCall)) continue;
      const fn = isRecord(rawCall.function) ? rawCall.function : {};
      const name = typeof fn.name === 'string' ? fn.name : '';
      if (name === '' || !declared.includes(name)) continue;
      const args = typeof fn.arguments === 'string'
        ? fn.arguments
        : JSON.stringify(isRecord(fn.arguments) ? fn.arguments : {});
      toolCalls.push({
        id: typeof rawCall.id === 'string' && rawCall.id !== '' ? rawCall.id : `call_${toolCalls.length}`,
        name,
        arguments: args,
      });
    }
  }
  return {
    valid: true,
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'chatcmpl-aggregate',
    created: Math.floor(numberOr(raw.created, 0)),
    text,
    toolCalls,
    finishReason: finishReasonOf(choice.finish_reason, toolCalls.length > 0),
    usage: usageOf(raw.usage, text),
  };
}

/** One model in OpenAI's list shape. */
export function openAIModelList(models: readonly ServedModel[]): Json {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      object: 'model',
      created: FIXED_OPENAI_CREATED,
      owned_by: model.provider,
    })),
  };
}

/** One model in Anthropic's list shape. */
export function anthropicModelList(models: readonly ServedModel[]): Json {
  return {
    data: models.map((model) => ({
      type: 'model',
      id: model.id,
      display_name: model.display_name,
      created_at: FIXED_ANTHROPIC_CREATED_AT,
    })),
    has_more: false,
  };
}

/** An error in OpenAI's shape. */
export function openAIError(message: string, type: string, code: string | null): Json {
  return { error: { message, type, code } };
}

/** An error in Anthropic's shape. */
export function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

/** One server-sent event with a named event, as Anthropic's wire uses. */
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One server-sent data frame, as OpenAI's wire uses. */
function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** One tool call in OpenAI's response shape. */
function openAIToolCall(call: ToolCall): Json {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
}

/** A completed answer as an OpenAI Chat Completions object, naming the model this entry dialled. */
export function renderOpenAIJson(answer: UpstreamAnswer, model: string): Json {
  const message: Json = { role: 'assistant', content: answer.text };
  if (answer.toolCalls.length > 0) message.tool_calls = answer.toolCalls.map(openAIToolCall);
  return {
    id: answer.id,
    object: 'chat.completion',
    created: answer.created,
    model,
    choices: [{ index: 0, message, finish_reason: answer.finishReason, logprobs: null }],
    usage: {
      prompt_tokens: answer.usage.input,
      completion_tokens: answer.usage.output,
      total_tokens: answer.usage.input + answer.usage.output,
    },
  };
}

/**
 * A completed answer as the OpenAI Chat Completions event stream: a role/content (and tool_calls) chunk,
 * one finish chunk, one usage chunk with no choices, then [DONE]. The client asked for a stream and this
 * is the event order its wire defines.
 */
export function renderOpenAIStream(answer: UpstreamAnswer, model: string): string {
  const base: Json = { id: answer.id, object: 'chat.completion.chunk', created: answer.created, model };
  const delta: Json = { role: 'assistant' };
  if (answer.text !== '') delta.content = answer.text;
  if (answer.toolCalls.length > 0) delta.tool_calls = answer.toolCalls.map(openAIToolCall);
  const frames = [
    sseData({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }),
    sseData({ ...base, choices: [{ index: 0, delta: {}, finish_reason: answer.finishReason }] }),
    sseData({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: answer.usage.input,
        completion_tokens: answer.usage.output,
        total_tokens: answer.usage.input + answer.usage.output,
      },
    }),
    'data: [DONE]\n\n',
  ];
  return frames.join('');
}

/** A completed answer as an Anthropic Messages object, naming the model this entry dialled. */
export function renderAnthropicJson(answer: UpstreamAnswer, model: string): Json {
  const content: Json[] = [];
  if (answer.text !== '') content.push({ type: 'text', text: answer.text });
  for (const call of answer.toolCalls) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: argumentsOf(call.arguments) });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: `msg_${answer.id}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(answer.finishReason),
    stop_sequence: null,
    usage: { input_tokens: answer.usage.input, output_tokens: answer.usage.output },
  };
}

/**
 * A completed answer as the Anthropic Messages event stream: message_start, one content block per text
 * or tool call with its start/delta/stop, then message_delta (stop reason and output usage) and
 * message_stop. The client asked for a stream and this is the order its wire defines.
 */
export function renderAnthropicStream(answer: UpstreamAnswer, model: string): string {
  const events: string[] = [];
  const messageId = `msg_${answer.id}`;
  events.push(sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: answer.usage.input, output_tokens: 0 },
    },
  }));

  let index = 0;
  if (answer.text !== '' || answer.toolCalls.length === 0) {
    const blockIndex = index;
    index += 1;
    events.push(sseEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    }));
    if (answer.text !== '') {
      events.push(sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: answer.text },
      }));
    }
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
  }
  for (const call of answer.toolCalls) {
    const blockIndex = index;
    index += 1;
    events.push(sseEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
    }));
    if (call.arguments !== '') {
      events.push(sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: call.arguments },
      }));
    }
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
  }
  events.push(sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: anthropicStopReason(answer.finishReason), stop_sequence: null },
    usage: { output_tokens: Math.max(1, answer.usage.output) },
  }));
  events.push(sseEvent('message_stop', { type: 'message_stop' }));
  return events.join('');
}

/** A short, safe code for a gateway refusal: its own error code, else its type, else the HTTP status. */
export function refusalCode(status: number, text: string): string {
  if (text !== '') {
    try {
      const value: unknown = JSON.parse(text);
      if (isRecord(value)) {
        const error = isRecord(value.error) ? value.error : null;
        if (error !== null) {
          if (typeof error.code === 'string' && error.code !== '') return error.code.slice(0, 64);
          if (typeof error.type === 'string' && error.type !== '') return error.type.slice(0, 64);
        }
        if (typeof value.type === 'string' && value.type !== '') return value.type.slice(0, 64);
      }
    } catch {
      // Not JSON: fall back to the status.
    }
  }
  return `http_${status}`;
}

/** The text body of a refusal, truncated for an error message. */
export function shorthand(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
