import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';

export async function migrate(DB) {
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    if (!name.endsWith('.sql')) continue;
    const sql = readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
    await DB.batch(
      sql
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => DB.prepare(part))
    );
  }
}

export async function database() {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: 'database-test',
          compatibilityDate: '2026-10-01',
          manifest: {
            mainModule: 'test.js',
            modules: {
              'test.js': {
                type: 'esm',
                contents: 'export default { fetch() { return new Response("test"); } }',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'test-db' } },
        },
      },
    ],
  });
  try {
    const DB = await runtime.getD1Database('DB');
    await migrate(DB);
    return {
      prepare: (sql) => DB.prepare(sql),
      batch: (queries) => DB.batch(queries),
      close: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
