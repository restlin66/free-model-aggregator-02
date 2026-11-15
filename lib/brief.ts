// The trial brief: the free-model table, the prompt manifest and the catalog document.
//
// A brief is prose with two JSON documents embedded in it. They are found by the `schema` member each
// carries under this competition's prefix, never by the order they appear in: the model table
// (`free-model-aggregator-02/models/v1`, also spelled `ratings` by the sibling contest) and the prompt
// manifest (`free-model-aggregator-02/prompts/v1`, also spelled `manifest`).
//
// Everything in this file is a pure function of the brief's bytes. There is no clock and no randomness,
// so `node main.ts --list` and the register body build the same catalog document byte for byte on a live
// pass and on its replay.

import { readFileSync } from 'node:fs';

/** The public endpoint of the provider whose free models this entry dials. */
export const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
/** The environment variable an entrant's OpenRouter key is pushed under; it never enters the sandbox. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

const SCHEMA_PREFIX = 'free-model-aggregator-02/';

export type Json = Record<string, unknown>;

/** True for a plain JSON object (not null, not an array). */
export const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** One free model exactly as the brief lists it. `id` is the id the gateway routes. */
export interface ModelRow {
  id: string;
  provider: string;
  display_name: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

/** What a prompt needs: a model that cannot do it cannot serve the prompt. */
export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

/** One prompt in the manifest, in the order the client will send it. */
export interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
  /** Some briefs publish the token; when they do it is a second way to identify the prompt. */
  token: string | null;
}

/** The brief as this entry reads it. `error` is set when a document could not be found. */
export interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

/** One model row of the catalog document. */
export interface CatalogModel {
  id: string;
  free: true;
  context_length: number | null;
}

/** The catalog document: the same object `--list` prints and the register body carries. */
export interface CatalogReport {
  providers: Array<{
    id: 'openrouter';
    base_url: string;
    key_env: string;
    wire: 'openai';
    models: CatalogModel[];
  }>;
}

/** The index of the `}` that closes the object opening at `start`, or -1. String bodies are skipped. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every embedded JSON object in the brief that carries a string `schema`, in the order they appear. */
function documentsIn(text: string): Json[] {
  const docs: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') docs.push(value);
    } catch {
      // Not a standalone JSON object: keep looking at the next `{`.
    }
  }
  return docs;
}

/** The first document under this contest's prefix that carries one of `keys` as an array. */
function arrayDocument(docs: readonly Json[], keys: readonly string[]): { doc: Json; key: string } | null {
  for (const doc of docs) {
    if (typeof doc.schema !== 'string' || !doc.schema.includes(SCHEMA_PREFIX)) continue;
    for (const key of keys) {
      if (Array.isArray(doc[key])) return { doc, key };
    }
  }
  return null;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * One model row. A row that gives a bare OpenRouter id (`vendor/model:free`) and names `openrouter` is
 * rewritten to the id the gateway routes (`openrouter/vendor/model:free`). A row is free unless it says
 * `free: false`; the catalog and the router never use a paid row.
 */
function modelOf(value: unknown): ModelRow | null {
  if (!isRecord(value)) return null;
  const raw = stringOf(value.id) !== '' ? stringOf(value.id) : stringOf(value.model);
  if (raw === '') return null;
  const provider = stringOf(value.provider) !== '' ? stringOf(value.provider) : 'openrouter';
  const id = provider === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/') ? `openrouter/${raw}` : raw;
  return {
    id,
    provider,
    display_name: stringOf(value.display_name) !== '' ? stringOf(value.display_name) : raw,
    rating_milli: numberOrNull(value.rating_milli) ?? 0,
    context_length: numberOrNull(value.context_length),
    tools: boolOrNull(value.tools),
    vision: boolOrNull(value.vision),
    json: boolOrNull(value.json),
    free: value.free !== false,
  };
}

/** The capabilities a prompt requires, keeping only the requirements that are actually set. */
function requirementsOf(value: unknown): Requirement {
  if (!isRecord(value)) return {};
  const requires: Requirement = {};
  if (value.tools === true) requires.tools = true;
  if (value.vision === true) requires.vision = true;
  if (value.json === true) requires.json = true;
  if (typeof value.min_context === 'number' && Number.isFinite(value.min_context)) {
    requires.min_context = value.min_context;
  }
  return requires;
}

function promptOf(value: unknown): PromptRow | null {
  if (!isRecord(value)) return null;
  const id = stringOf(value.id);
  if (id === '') return null;
  return {
    id,
    api: value.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: value.stream === true,
    weight: value.weight === 2 ? 2 : 1,
    requires: requirementsOf(value.requires),
    token: stringOf(value.token) !== '' ? stringOf(value.token) : null,
  };
}

/**
 * Read the brief at `path`. A brief may hold one document with both arrays or two documents; each is
 * found by the array it carries. The returned arrays keep the brief's order, which is the order the
 * client sends its prompts in and the order the catalog lists its models in.
 */
export function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const modelsDoc = arrayDocument(docs, ['models', 'ratings']);
  const promptsDoc = arrayDocument(docs, ['prompts', 'manifest']);
  const models = modelsDoc === null
    ? []
    : (modelsDoc.doc[modelsDoc.key] as unknown[]).flatMap((value) => {
        const model = modelOf(value);
        return model === null ? [] : [model];
      });
  const prompts = promptsDoc === null
    ? []
    : (promptsDoc.doc[promptsDoc.key] as unknown[]).flatMap((value) => {
        const prompt = promptOf(value);
        return prompt === null ? [] : [prompt];
      });
  let error: string | null = null;
  if (modelsDoc === null) error = `the brief at ${path} holds no free-model document`;
  else if (promptsDoc === null) error = `the brief at ${path} holds no prompt manifest`;
  return { models, prompts, error };
}

/** The free models the brief lists, each id once, in the brief's order. */
export function freeModels(brief: Brief): ModelRow[] {
  const seen = new Set<string>();
  const out: ModelRow[] = [];
  for (const model of brief.models) {
    if (!model.free || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/** Whether a model's published capabilities meet a prompt's requirements. Unknown never meets one. */
export function meetsRequirement(requires: Requirement, model: ModelRow): boolean {
  if (requires.tools === true && model.tools !== true) return false;
  if (requires.vision === true && model.vision !== true) return false;
  if (requires.json === true && model.json !== true) return false;
  if (requires.min_context !== undefined) {
    if (model.context_length === null || model.context_length < requires.min_context) return false;
  }
  return true;
}

/**
 * The catalog document. It holds exactly the brief's free models, one row each, in the brief's order.
 * `base_url` is the provider's public endpoint, never the gateway's trial-local address: the catalog is
 * part of the state export a replay compares byte for byte, and the gateway's origin differs between a
 * live pass and its replay.
 */
export function buildCatalog(brief: Brief): CatalogReport {
  const models = freeModels(brief).map((model) => ({
    id: model.id,
    free: true as const,
    context_length: model.context_length,
  }));
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}
