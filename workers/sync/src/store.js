/** Un dataset = un hash SHA-256. Si no cambió, no hay INSERT/UPDATE. */

const CHUNK = 80_000;

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new TextEncoder().encode(String(value ?? ""));
}

export async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function splitChunks(bytes, size = CHUNK) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    parts.push(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
  }
  return parts.length ? parts : [new Uint8Array()];
}

export function joinChunks(parts) {
  const list = parts.map(part => part instanceof Uint8Array ? part : new Uint8Array(part));
  const total = list.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of list) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function blobBind(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function headOf(env, key) {
  return env.DB.prepare(
    "SELECT generation, sha256, updated_at, parts, raw_bytes FROM dataset_heads WHERE key = ?"
  ).bind(key).first();
}

export async function putIfChanged(env, key, raw, updatedAt) {
  const bytes = toBytes(raw);
  const sha256 = await sha256Hex(bytes);
  const current = await headOf(env, key);
  if (current && current.sha256 === sha256) {
    return { key, sha256, updated_at: current.updated_at, skipped: true, parts: current.parts };
  }
  const gzip = await gzipBytes(bytes);
  const parts = splitChunks(gzip);
  const generation = Number(current?.generation || 0) + 1;
  const statements = parts.map((part, index) => env.DB.prepare(
    "INSERT INTO dataset_parts (key, generation, part, gzip) VALUES (?, ?, ?, ?)"
  ).bind(key, generation, index, blobBind(part)));
  statements.push(env.DB.prepare(
    `INSERT INTO dataset_heads (key, generation, sha256, updated_at, parts, raw_bytes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       generation = excluded.generation,
       sha256 = excluded.sha256,
       updated_at = excluded.updated_at,
       parts = excluded.parts,
       raw_bytes = excluded.raw_bytes`
  ).bind(key, generation, sha256, updatedAt, parts.length, bytes.length));
  if (current) {
    statements.push(env.DB.prepare(
      "DELETE FROM dataset_parts WHERE key = ? AND generation <> ?"
    ).bind(key, generation));
  }
  await env.DB.batch(statements);
  return { key, sha256, updated_at: updatedAt, skipped: false, parts: parts.length, raw_bytes: bytes.length };
}

export async function readGzip(env, key) {
  const head = await headOf(env, key);
  if (!head) return null;
  const { results } = await env.DB.prepare(
    "SELECT part, gzip FROM dataset_parts WHERE key = ? AND generation = ? ORDER BY part"
  ).bind(key, head.generation).all();
  const ordered = (results || []).slice().sort((a, b) => a.part - b.part);
  return {
    gzip: joinChunks(ordered.map(row => row.gzip)),
    updated_at: head.updated_at,
    sha256: head.sha256,
    raw_bytes: head.raw_bytes
  };
}

export async function readJson(env, key) {
  const stored = await readGzip(env, key);
  if (!stored) return null;
  const text = new TextDecoder().decode(await gunzipBytes(stored.gzip));
  return { json: JSON.parse(text), updated_at: stored.updated_at, sha256: stored.sha256, text };
}

export async function putJsonIfChanged(env, key, value, updatedAt) {
  return putIfChanged(env, key, JSON.stringify(value), updatedAt);
}
