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
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(50) PRIMARY KEY,
      login VARCHAR(100) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      plain_password TEXT DEFAULT 'admin123',
      full_name VARCHAR(200) NOT NULL,
      role VARCHAR(50) DEFAULT 'master',
      area VARCHAR(100) DEFAULT '',
      color VARCHAR(20) DEFAULT '#2563eb',
      active BOOLEAN DEFAULT true,
      created BIGINT DEFAULT 0
    )
  `);

  // Виды работ (хранятся по участкам)
  await query(`
    CREATE TABLE IF NOT EXISTS works (
      id VARCHAR(50) NOT NULL,
      area VARCHAR(100) NOT NULL,
      "group" VARCHAR(200) DEFAULT 'Без группы',
      name VARCHAR(300) NOT NULL,
      norm NUMERIC DEFAULT 0,
      unit VARCHAR(20) DEFAULT 'объект',
      needs_permit BOOLEAN DEFAULT false,
      depends_on_snow BOOLEAN DEFAULT false,
      min_temp NUMERIC DEFAULT -50,
      season VARCHAR(50) DEFAULT 'Круглый год',
      equipment VARCHAR(200) DEFAULT '—',
      min_workers INT DEFAULT 1,
      opt_workers INT DEFAULT 2,
      PRIMARY KEY (id, area)
    )
  `);

  // Объекты
  await query(`
    CREATE TABLE IF NOT EXISTS objects (
      id VARCHAR(50) PRIMARY KEY,
      addr TEXT NOT NULL,
      type VARCHAR(50) DEFAULT 'Объект',
      lat NUMERIC,
      lng NUMERIC,
      zu INT DEFAULT 0,
      area_obj NUMERIC DEFAULT 0,
      length_km NUMERIC DEFAULT 0,
      area_ha NUMERIC DEFAULT 0
    )
  `);

  // Задания
  await query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id VARCHAR(100) PRIMARY KEY,
      addr TEXT,
      o VARCHAR(50),
      w VARCHAR(50),
      works TEXT,
      m VARCHAR(50) NOT NULL,
      d INT DEFAULT 0,
      dl INT DEFAULT 7,
      s VARCHAR(20) DEFAULT 'plan',
      status VARCHAR(20) DEFAULT 'plan',
      volume NUMERIC DEFAULT 1,
      dl_date VARCHAR(20),
      needs_permit BOOLEAN DEFAULT false,
      depends_on_snow BOOLEAN DEFAULT false,
      min_temp NUMERIC DEFAULT -50,
      equipment VARCHAR(200) DEFAULT '—',
      travel_min INT DEFAULT 15,
      travel_km NUMERIC,
      travel_km_text VARCHAR(50),
      travel_text VARCHAR(100),
      created BIGINT DEFAULT 0
    )
  `);

  console.log('База данных инициализирована');

  // Таблица базы знаний AI (общая для всех)
  await query(`
    CREATE TABLE IF NOT EXISTS ai_kb (
      id INT PRIMARY KEY DEFAULT 1,
      text TEXT DEFAULT '',
      updated_at BIGINT DEFAULT 0,
      updated_by VARCHAR(200) DEFAULT ''
    )
  `);
  await query(`INSERT INTO ai_kb (id, text) VALUES (1, '') ON CONFLICT (id) DO NOTHING`);

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
}
