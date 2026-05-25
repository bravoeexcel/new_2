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
 */

'use strict';

const express  = require('express');
const { Pool } = require('pg');
const cors     = require('cors');

// ── DB connection ─────────────────────────────────────────────────────────────

const connStr = process.env.DATABASE_URL || process.env.POSTGRES_URI;

if (!connStr) {
  console.error('❌ FATAL: No database connection string found.');
  console.error('   Set DATABASE_URL in your Zeabur service environment variables.');
  console.error('   Go to: Zeabur dashboard → your Node service → Variables tab');
  console.error('   Then link your PostgreSQL service so DATABASE_URL is injected automatically.');
  process.exit(1);
}

console.log('✅ Database URL found, connecting...');

const pool = new Pool({ connectionString: connStr });

// ── Auto-create table on startup ──────────────────────────────────────────────

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS netiva_store (
        doc_id TEXT PRIMARY KEY,
        data   JSONB NOT NULL DEFAULT '{}'
      )
    `);
    console.log('✅ netiva_store table ready');

    // Verify we can actually read/write
    await pool.query(`
      INSERT INTO netiva_store (doc_id, data)
      VALUES ('__healthcheck__', '{"ok":true}')
      ON CONFLICT (doc_id) DO UPDATE SET data = EXCLUDED.data
    `);
    console.log('✅ Database read/write verified');
  } catch (e) {
    console.error('❌ DB init failed:', e.message);
    console.error('   Full error:', e);
  }
}

initDB();

// ── App & Middleware ──────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Optional API-key guard
app.use((req, res, next) => {
  const expected = process.env.API_KEY;
  if (!expected) return next();
  if (req.headers['x-api-key'] === expected) return next();
  console.warn('⚠️  Unauthorized request from', req.ip, 'to', req.path);
  res.status(401).json({ error: 'Unauthorized' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function deepMerge(dst, src) {
  if (!dst || typeof dst !== 'object') return src;
  const out = { ...dst };
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
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
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: rows[0].data });
  } catch (e) {
    console.error('GET /store/' + doc_id, e.message);
    res.status(500).json({ error: e.message });
  }
});

/** POST /store/:doc_id — full upsert */
app.post('/store/:doc_id', async (req, res) => {
  const { doc_id } = req.params;
  const { data }   = req.body;
  if (data === undefined) return res.status(400).json({ error: 'Missing "data" field' });
  try {
    await pool.query(
      `INSERT INTO netiva_store (doc_id, data)
       VALUES ($1, $2)
       ON CONFLICT (doc_id) DO UPDATE SET data = EXCLUDED.data`,
      [doc_id, JSON.stringify(data)]
    );
    console.log('✅ Saved:', doc_id);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /store/' + doc_id, e.message);
    res.status(500).json({ error: e.message });
  }
});

/** POST /store/:doc_id/merge — deep-merge upsert */
app.post('/store/:doc_id/merge', async (req, res) => {
  const { doc_id } = req.params;
  const { data }   = req.body;
  if (data === undefined) return res.status(400).json({ error: 'Missing "data" field' });
  try {
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
    console.log('✅ Merged:', doc_id);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /store/' + doc_id + '/merge', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Health check — also tests DB connection
app.get('/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) FROM netiva_store');
    res.json({ status: 'ok', rows: parseInt(rows[0].count) });
  } catch (e) {
    res.status(500).json({ status: 'db_error', error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Netiva API listening on port', PORT));
