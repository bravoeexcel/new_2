/**
 * server.js — Netiva store backend for Zeabur PostgreSQL
 *
 * Deploy this file (plus package.json) to a Zeabur Node.js service.
 *
 * Environment variables (set in the Zeabur dashboard):
 *   DATABASE_URL  — provided automatically when you link a Zeabur PostgreSQL
 *                   service, e.g. postgres://user:pass@host:5432/dbname
 *   API_KEY       — shared secret that index.html sends as 'x-api-key'
 *                   Leave unset to disable auth (dev only)
 *   PORT          — Zeabur sets this automatically
 *
 * One-time DB setup (run once against your Zeabur PostgreSQL):
 *   CREATE TABLE IF NOT EXISTS netiva_store (
 *     doc_id TEXT PRIMARY KEY,
 *     data   JSONB NOT NULL DEFAULT '{}'
 *   );
 *
 * API surface:
 *   GET  /store/:doc_id          → { data: <jsonb> } | 404
 *   POST /store/:doc_id          → upsert (full replace)
 *   POST /store/:doc_id/merge    → deep-merge upsert
 */

'use strict';

const express  = require('express');
const { Pool } = require('pg');
const cors     = require('cors');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());          // Allow requests from your HTML page's origin
app.use(express.json({ limit: '10mb' }));  // QR images can be large

// Optional API-key guard
app.use((req, res, next) => {
  const expected = process.env.API_KEY;
  if(!expected) return next();                        // auth disabled
  if(req.headers['x-api-key'] === expected) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively merge src into dst (handles nested objects, not arrays) */
function deepMerge(dst, src){
  if(!dst || typeof dst !== 'object') return src;
  const out = { ...dst };
  for(const k of Object.keys(src)){
    if(src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])){
      out[k] = deepMerge(dst[k], src[k]);
    } else {
      out[k] = src[k];
    }
  }
  return out;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /store/:doc_id */
app.get('/store/:doc_id', async (req, res) => {
  const { doc_id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT data FROM netiva_store WHERE doc_id = $1',
      [doc_id]
    );
    if(!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: rows[0].data });
  } catch(e) {
    console.error('GET /store/'+doc_id, e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /store/:doc_id — full upsert */
app.post('/store/:doc_id', async (req, res) => {
  const { doc_id } = req.params;
  const { data }   = req.body;
  if(data === undefined) return res.status(400).json({ error: 'Missing "data" field' });
  try {
    await pool.query(
      `INSERT INTO netiva_store (doc_id, data)
       VALUES ($1, $2)
       ON CONFLICT (doc_id) DO UPDATE SET data = EXCLUDED.data`,
      [doc_id, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('POST /store/'+doc_id, e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /store/:doc_id/merge — deep-merge upsert */
app.post('/store/:doc_id/merge', async (req, res) => {
  const { doc_id } = req.params;
  const { data }   = req.body;
  if(data === undefined) return res.status(400).json({ error: 'Missing "data" field' });
  try {
    // Fetch existing row then merge in JS (keeps logic identical to the old
    // Supabase adapter and avoids complex JSONB merge SQL)
    const { rows } = await pool.query(
      'SELECT data FROM netiva_store WHERE doc_id = $1',
      [doc_id]
    );
    const merged = rows.length ? deepMerge(rows[0].data, data) : data;
    await pool.query(
      `INSERT INTO netiva_store (doc_id, data)
       VALUES ($1, $2)
       ON CONFLICT (doc_id) DO UPDATE SET data = EXCLUDED.data`,
      [doc_id, JSON.stringify(merged)]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('POST /store/'+doc_id+'/merge', e);
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Netiva API listening on port', PORT));
