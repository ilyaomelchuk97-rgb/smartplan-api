import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Запрос выполнен', { text: text.substring(0, 60), duration, rows: res.rowCount });
  return res;
}

// Создание таблиц при первом запуске
export async function initDB() {
  // Пользователи

  // Таблица логов действий пользователей
  await query(`
    CREATE TABLE IF NOT EXISTS action_logs (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(50),
      user_name VARCHAR(200),
      action VARCHAR(300),
      details TEXT DEFAULT '',
      created_at BIGINT DEFAULT 0
    )
  `);
  // Миграции справочника объектов: ответственный за объект (ГРП/ШРП/ГРС/ПГРП)
  await query(`ALTER TABLE objects ADD COLUMN IF NOT EXISTS resp_id VARCHAR(50) DEFAULT ''`).catch(() => {});
  await query(`ALTER TABLE objects ADD COLUMN IF NOT EXISTS resp_name VARCHAR(200) DEFAULT ''`).catch(() => {});
}