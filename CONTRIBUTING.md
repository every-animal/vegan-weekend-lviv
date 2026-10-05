# Як вносити зміни

1. **Гілка від `main`**: `git switch -c <що-робимо>` (напр. `price-600`, `favicon`, `cookies-logic`).
2. **Зміни лише в `site/`** (і в `docs/`, якщо змінилось рішення чи процес). `handoff/` — довідка, не редагувати; виняток — селектори в `handoff/checks/behaviour.js`, якщо перейменовано клас.
3. **Перевірити локально**: `pnpm dev` + `pnpm check http://localhost:8080/` → `48 checks, 0 failed`; порівняти зі знімками `handoff/screens/` і з еталоном (`pnpm reference`).
4. **Push → Pull Request** у `main`. Автоматично:
   - GitHub Actions проганяє 48 перевірок;
   - Vercel публікує **Preview** і пише посилання в PR — його й показуємо власнику.
5. **Merge в `main`** — після зеленого CI і «ок» власника на Preview. Merge = деплой у Production (див. [docs/DEPLOY.md](docs/DEPLOY.md)).

## Правила

- Пряма робота в `main` заборонена (захист гілки на GitHub): лише через PR.
- Нове рішення власника → рядок у [docs/DECISIONS.md](docs/DECISIONS.md) у тому ж PR.
- Закрили задачу з [docs/BACKLOG.md](docs/BACKLOG.md) → оновити статус у тому ж PR.
- Ніяких секретів у коді. Ідентифікатори тегів Google/Meta — не секрет (вони видні в браузері), їх можна тримати в `site/`.
- Тексти, кольори, шрифт, переноси, SVG-координати — див. «Жорсткі правила» в [CLAUDE.md](CLAUDE.md).

## Нова людина в команді

Див. [docs/SETUP.md](docs/SETUP.md), розділ «Доступ для команди».
