# Веган Вікенд Львів — лендінг

Сайт фестивалю **Веган Вікенд Львів** · 22 листопада 2026 · Jam Factory Art Center.
Проєкт ГО **«Кожна Тварина»** (Every Animal). Майбутня адреса: https://www.veganweekend.org/

Статичний сайт без збирання: HTML + CSS + JS, власні шрифти й фото. Хостинг — Vercel, деплой автоматично з GitHub.

## Швидкий старт

```bash
git clone https://github.com/every-animal/vegan-weekend-lviv.git
cd vegan-weekend-lviv
pnpm install            # Playwright для перевірок + git-хуки
pnpm browsers           # один раз: Chromium для перевірок
pnpm dev                # сайт → http://localhost:8080/
pnpm reference          # еталон дизайну → http://localhost:8081/
pnpm check http://localhost:8080/   # 48 перевірок поведінки, ~1 хв
```

Потрібно: Node 20+, pnpm, Python 3 (для локального сервера).

## Структура

```
site/          сайт — лише це публікується на Vercel
api/           серверні функції Vercel: wayforpay.mjs (оплати → Meta / GA4), dashboard.mjs (дашборд продажів)
tests/         тести функцій (pnpm test)
handoff/       пакет від дизайну: еталон, SPEC, ANIMATIONS, CONTENT, ASSETS, знімки, перевірки
docs/          SETUP · DEPLOY · DECISIONS · BACKLOG
.github/       CI (перевірки на кожен PR), шаблон PR
.githooks/     pre-push: пуш лише в github.com/every-animal/
CLAUDE.md      правила проєкту (для людей і для Claude Code); AGENTS.md → те саме
vercel.json    налаштування публікації
```

## Документи

| Хочу… | Читати |
|---|---|
| зрозуміти правила й дизайн | [CLAUDE.md](CLAUDE.md), далі [handoff/README.md](handoff/README.md) |
| отримати доступи й налаштувати машину | [docs/SETUP.md](docs/SETUP.md) |
| внести зміну | [CONTRIBUTING.md](CONTRIBUTING.md) |
| задеплоїти / перемкнути домен | [docs/DEPLOY.md](docs/DEPLOY.md) |
| зрозуміти, як покупки потрапляють у Meta / Google | [docs/PAYMENTS.md](docs/PAYMENTS.md) |
| подивитись продажі / налаштувати дашборд | [docs/DASHBOARD.md](docs/DASHBOARD.md) |
| дізнатись, чому так вирішили | [docs/DECISIONS.md](docs/DECISIONS.md) |
| що лишилось зробити | [docs/BACKLOG.md](docs/BACKLOG.md) |
