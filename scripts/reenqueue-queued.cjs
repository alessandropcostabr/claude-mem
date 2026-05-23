// re-enfileira jobs STUCK em queued (attempts>0, fora do BullMQ). uso: bun reenqueue-queued.cjs [LIMIT]
const { Queue } = require('bullmq'); const { Pool } = require('pg'); const IORedis = require('ioredis');
const LIMIT = parseInt(process.argv[2] || '15', 10);
const chunk = (a,n)=>a.reduce((c,x,i)=>(i%n?c[c.length-1].push(x):c.push([x]),c),[]);
(async () => {
  const conn = new IORedis(process.env.CLAUDE_MEM_REDIS_URL, { maxRetriesPerRequest: null });
  const pool = new Pool({ connectionString: process.env.CLAUDE_MEM_SERVER_DATABASE_URL });
  const q = new Queue('server_beta_generate_event', { connection: conn, prefix: 'claude_mem_37700' });
  const { rows } = await pool.query(
    "SELECT id, bullmq_job_id, job_type, payload FROM observation_generation_jobs WHERE status='queued' AND source_type='agent_event' AND attempts>0 ORDER BY created_at LIMIT $1", [LIMIT]);
  console.log('selecionados:', rows.length);
  if(!rows.length){await q.close();await conn.quit();await pool.end();process.exit(0);}
  await pool.query("UPDATE observation_generation_jobs SET attempts=0, last_error=NULL, locked_at=NULL, locked_by=NULL, next_attempt_at=NULL, updated_at=now() WHERE id=ANY($1)",[rows.map(r=>r.id)]);
  for (const c of chunk(rows,100)) await Promise.all(c.map(async r=>{try{await q.remove(r.bullmq_job_id)}catch(e){}}));
  await q.addBulk(rows.map(r => ({ name: r.job_type, data: r.payload, opts: { jobId: r.bullmq_job_id } })));
  console.log('re-enfileirados:', rows.length);
  await q.close(); await conn.quit(); await pool.end(); process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
