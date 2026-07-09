# SmartPlan УБиРОГС — Деплой

## Архитектура

```
┌─────────────┐         ┌──────────────┐         ┌──────────────┐
│  Netlify    │  HTTPS  │  Render API   │  SQL    │  PostgreSQL  │
│  (фронтенд) │ ──────► │  (Node.js)    │ ──────► │  (данные)    │
│  Статика   │         │  Express      │         │              │
└─────────────┘         └──────────────┘         └──────────────┘
   uploads/                backend/                Render DB
```

## Шаг 1. Подготовка репозитория

Загрузите все файлы в GitHub-репозиторий:
```
/ (корень репозитория)
├── uploads/           ← фронтенд (для Netlify)
│   ├── index.html
│   ├── app.js
│   ├── config.js
│   ├── data.js
│   ├── db.js
│   ├── users_db.js
│   ├── work_db.js
│   ├── objects_db.js
│   ├── tasks_db.js
│   ├── xlsx.full.min.js
│   └── logo.png
├── backend/           ← бэкенд (для Render)
│   ├── server.js
│   ├── db.js
│   └── package.json
├── render.yaml        ← конфиг авто-деплоя Render
└── netlify.toml       ← конфиг деплоя Netlify
```

## Шаг 2. Деплой бэкенда на Render

### Вариант А: Авто-деплой (проще)
1. Зайдите на https://dashboard.render.com
2. Нажмите **New +** → **Blueprint**
3. Выберите ваш GitHub-репозиторий
4. Render автоматически создаст:
   - **Web Service** `smartplan-api` (Node.js)
   - **PostgreSQL** `smartplan-db` (бесплатная БД)
5. Дождитесь деплоя (3-5 минут)
6. Скопируйте URL: `https://smartplan-api.onrender.com`

### Вариант Б: Вручную
1. **New +** → **PostgreSQL** → имя `smartplan-db` → **Create**
2. **New +** → **Web Service** → выберите репозиторий
   - Name: `smartplan-api`
   - Root: `backend`
   - Build: `npm install`
   - Start: `node server.js`
   - Environment variables:
     - `DATABASE_URL` → из созданной БД (вкладка "Connections")
3. Нажмите **Create Web Service**

### Проверка
Откройте `https://smartplan-api.onrender.com/api/health` — должно вернуть:
```json
{"status":"ok","timestamp":1234567890}
```

### Сидинг (начальные данные)
Выполните POST-запрос на `https://smartplan-api.onrender.com/api/seed`
(через curl, Postman или браузерную консоль):
```bash
curl -X POST https://smartplan-api.onrender.com/api/seed
```
Это создаст пользователя `admin` / `admin123` и базовые справочники.

## Шаг 3. Настройка фронтенда

Откройте `uploads/config.js` и замените URL:
```javascript
return 'https://smartplan-api.onrender.com';  // ← ваш URL
```

## Шаг 4. Деплой фронтенда на Netlify

1. Зайдите на https://app.netlify.com
2. **Add new site** → **Import from Git**
3. Выберите репозиторий
4. Настройки:
   - Base directory: (пусто)
   - Build command: (пусто)
   - Publish directory: `uploads`
5. **Deploy site**

Готово! Сайт будет доступен по адресу вида:
`https://smartplan-ubirogs.netlify.app`

## Шаг 5. Локальная разработка

### Бэкенд
```bash
cd backend
npm install
# Установите PostgreSQL или используйте Docker:
# docker run -d --name smartplan-db -p 5432:5432 -e POSTGRES_DB=smartplan -e POSTGRES_PASSWORD=pass postgres:16
DATABASE_URL=postgresql://postgres:pass@localhost:5432/smartplan node server.js
```

### Фронтенд
Откройте `uploads/index.html` через локальный сервер:
```bash
cd uploads
python3 -m http.server 8080
# Откройте http://localhost:8080
```
В `config.js` локальный режим определяется автоматически.

## Управление данными

| Данные | Где хранятся | API |
|--------|-------------|-----|
| Пользователи | PostgreSQL | `/api/users` |
| Виды работ | PostgreSQL | `/api/works/:area` |
| Объекты | PostgreSQL | `/api/objects` |
| Задания | PostgreSQL | `/api/tasks` |

## Troubleshooting

**Сервер недоступен?** Приложение автоматически переключается в автономный режим (localStorage).

**Бесплатный тариф Render:** сервер «засыпает» через 15 минут бездействия. Первый запрос после сна занимает ~30 сек.

**CORS:** Настроен на сервере — `Access-Control-Allow-Origin: *`.
