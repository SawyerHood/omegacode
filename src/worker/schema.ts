// JSON Schema → per-provider output-format shapes + client-side validation.
//   Codex:  turn/start.outputSchema = <json schema>
//   Claude: options.outputFormat = { type: "json_schema", schema: <json schema> }
// We always re-validate the returned value client-side regardless of provider enforcement.

import { Ajv, type ValidateFunction } from "ajv"
import type { JSONSchema } from "../dsl/types.js"

const ajv = new Ajv({ allErrors: true, strict: false })
const cache = new WeakMap<JSONSchema, ValidateFunction>()

function compile(schema: JSONSchema): ValidateFunction {
  const existing = cache.get(schema)
  if (existing) return existing
  const fn = ajv.compile(schema)
  cache.set(schema, fn)
  return fn
}

export interface ValidationResult {
  ok: boolean
  errors?: string
}

export function validate(schema: JSONSchema, value: unknown): ValidationResult {
  const fn = compile(schema)
  if (fn(value)) return { ok: true }
  const errors = (fn.errors ?? [])
    .map((e) => `${e.instancePath || "root"}: ${e.message ?? "invalid"}`)
    .join("; ")
  return { ok: false, errors }
}

/** OpenAI/Codex strict json_schema requires additionalProperties:false + all keys required. */
export function toCodexOutputSchema(schema: JSONSchema): JSONSchema {
  return strictify(schema) as JSONSchema
}

export function toClaudeOutputFormat(schema: JSONSchema): { type: "json_schema"; schema: JSONSchema } {
  return { type: "json_schema", schema }
}

function strictify(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node.map(strictify)
  const obj = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = strictify(v)
  const props = out.properties
  if ((out.type === "object" || props !== undefined) && props && typeof props === "object") {
    const properties = props as Record<string, unknown>
    const keys = Object.keys(properties)
    const originalRequired = new Set(Array.isArray(out.required) ? (out.required as string[]) : [])
    out.additionalProperties = false
    // OpenAI strict mode requires EVERY property in `required`. Keep originally-optional
    // properties semantically optional by making them nullable.
    out.required = keys
    for (const k of keys) {
      if (!originalRequired.has(k)) properties[k] = makeNullable(properties[k])
    }
  }
  return out
}

function makeNullable(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema
  const s = schema as Record<string, unknown>
  const t = s.type
  if (typeof t === "string" && t !== "null") return { ...s, type: [t, "null"] }
  if (Array.isArray(t) && !t.includes("null")) return { ...s, type: [...t, "null"] }
  return s
}

/**
 * Normalize structured output before validation: drop `null` values for properties that are NOT
 * required. Codex's strict `outputSchema` forces every key to be present, so we express optional
 * fields as nullable — the model returns `null` to mean "absent". This restores that semantics so
 * the value validates against the author's original (optional) schema. Harmless for Claude output.
 */
export function stripNullOptionals(value: unknown, schema: JSONSchema): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) {
    const itemSchema = (schema.items as JSONSchema | undefined) ?? {}
    return value.map((v) => stripNullOptionals(v, itemSchema))
  }
  const props = (schema.properties as Record<string, JSONSchema> | undefined) ?? {}
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null && !required.has(k)) continue // optional + null → omit
    out[k] = stripNullOptionals(v, props[k] ?? {})
  }
  return out
}

/** Best-effort: parse a model's text output as JSON (handles ```json fences). */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const candidate = fence ? fence[1]! : trimmed
  return JSON.parse(candidate)
}
