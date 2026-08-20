
import pg from 'pg';
const url = process.argv[2];
const shown = url.replace(/:[^:@]*@/, ':***@');
console.log('пробую', shown);
const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 });
try {
  await c.connect();
  const r = await c.query('select count(*)::int as n from ug_default.nodes');
  console.log('OK, узлов:', r.rows[0].n);
  await c.end();
} catch (e) {
  console.log('ОШИБКА:', e.code || '', e.message);
  if (e.address || e.port) console.log('  адрес назначения:', e.address, e.port);
}
