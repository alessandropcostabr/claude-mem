#!/usr/bin/env bun
// reprocess-failed.cjs — re-enfileira jobs failed do server-beta (PG reset + Redis remove + addBulk)
// uso: bun reprocess-failed.cjs [LIMIT=50] [SOURCE=agent_event]
const { Queue } = require('bullmq');
const { Pool } = require('pg');
const IORedis = require('ioredis');

const LIMIT = parseInt(process.argv[2] || '50', 10);
const SOURCE = process.argv[3] || 'agent_event';
const PREFIX = 'claude_mem_37700';
const QMAP = { agent_event: 'server_beta_generate_event', session_summary: 'server_beta_generate_summary' };
const QNAME = QMAP[SOURCE];
if (!QNAME) { console.error('source inválido:', SOURCE); process.exit(1); }

const chunk = (a, n) => a.reduce((acc, x, i) => (i % n ? acc[acc.length-1].push(x) : acc.push([x]), acc), []);

(async () => {
  const conn = new IORedis(process.env.CLAUDE_MEM_REDIS_URL, { maxRetriesPerRequest: null });
  const pool = new Pool({ connectionString: process.env.CLAUDE_MEM_SERVER_DATABASE_URL });
  const queue = new Queue(QNAME, { connection: conn, prefix: PREFIX });

  const { rows } = await pool.query(
    `SELECT id, bullmq_job_id, job_type, payload FROM observation_generation_jobs
     WHERE status='failed' AND source_type=$1 ORDER BY created_at LIMIT $2`, [SOURCE, LIMIT]);
  if (!rows.length) { console.log('nada failed para', SOURCE); await conn.quit(); await pool.end(); process.exit(0); }
  console.log('selecionados:', rows.length);

  // 1. reset PG -> queued
  await pool.query(
    `UPDATE observation_generation_jobs SET status='queued', attempts=0, last_error=NULL,
     failed_at=NULL, locked_at=NULL, locked_by=NULL, next_attempt_at=NULL, updated_at=now()
     WHERE id = ANY($1)`, [rows.map(r => r.id)]);
  console.log('PG resetado -> queued');

  // 2. remove jobIds do Redis (mata dedup) em chunks paralelos
  let removed = 0;
  for (const c of chunk(rows, 100)) { await Promise.all(c.map(async r => { try { await queue.remove(r.bullmq_job_id); removed++; } catch(e){} })); }
  console.log('removidos do Redis:', removed);

  // 3. addBulk em chunks
  let added = 0;
  for (const c of chunk(rows, 500)) {
    await queue.addBulk(c.map(r => ({ name: r.job_type, data: r.payload, opts: { jobId: r.bullmq_job_id } })));
    added += c.length;
  }
  console.log('re-enfileirados:', added);
  await queue.close(); await conn.quit(); await pool.end(); process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
