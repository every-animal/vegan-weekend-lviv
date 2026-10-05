# Акаунти, доступи, налаштування машини

## Карта акаунтів

| Сервіс | Що | Власник / пошта | Хто має доступ |
|---|---|---|---|
| GitHub | організація **`every-animal`**, репозиторій `vegan-weekend-lviv` (публічний) | акаунт на **hello@everyanimal.org** — owner організації | члени команди — своїми GitHub-акаунтами, запрошені в організацію |
| Vercel | проєкт **`vegan-weekend-lviv`** (план Hobby), підключений до репозиторію | акаунт на **hello@everyanimal.org** (вхід через GitHub-акаунт організації) | лише власник акаунта; команді доступ до Vercel не потрібен — деплой іде з Git |
| Домен | `veganweekend.org` | власник проєкту | перемикає лише власник (див. [DEPLOY.md](DEPLOY.md)) |

Паролі й 2FA-коди від hello@everyanimal.org-акаунтів — у менеджері паролів організації, не в репозиторії й не в чатах.

## Перший запуск (один раз, робить власник)

1. **GitHub-акаунт** на hello@everyanimal.org → увімкнути 2FA.
2. **GitHub Organization** `every-animal` (Free) від цього акаунта.
3. **Vercel-акаунт**: vercel.com/signup → *Continue with GitHub* під акаунтом з п. 1 (так пошта й власник збігаються, а Vercel одразу бачить репозиторії організації). Під час підключення GitHub App дати доступ **лише** до `every-animal/vegan-weekend-lviv`.
4. Далі — розділ «Машина Alex» нижче: залогінити `ea-gh` і `ea-vercel`, створити репозиторій і проєкт.
5. GitHub → Settings → Branches: захист `main` (лише через PR, обовʼязковий check `behaviour`).
6. Vercel → Project → Settings → Deployment Protection: **вимкнути Vercel Authentication для Preview**, інакше команда не відкриє превʼю з PR (на них і так стоїть `noindex`).

## Доступ для команди

- **Розробник:** GitHub → Organization `every-animal` → People → Invite → роль *Member*, у репозиторії — *Write*. Далі людина клонує репозиторій і йде за [README](../README.md), «Швидкий старт». Vercel-доступ не потрібен: push → Preview-посилання в PR.
- **Хто лише дивиться й погоджує:** достатньо Preview-посилань у PR — акаунт не потрібен.
- Пішла людина → прибрати з організації.

## Машина Alex: ізоляція від інших організацій

Alex працює з цієї машини на кілька організацій, тому акаунти Кожної Тварини відокремлені. Усе лежить у `~/everyanimal/` (поза іншими робочими теками).

| Що | Як ізольовано |
|---|---|
| **git-автор** | `~/.gitconfig` → `includeIf "gitdir:~/everyanimal/"` → `~/.gitconfig-everyanimal`: email `hello@everyanimal.org` у всіх репозиторіях під `~/everyanimal/` |
| **git push** | там же: HTTPS-доступ до GitHub бере токен з **ізольованого** gh (`~/everyanimal/.config/gh`), а SSH-адреси GitHub переписуються на HTTPS — особистий SSH-ключ і особистий gh тут не діють |
| **gh** | `ea-gh` = `gh` з `GH_CONFIG_DIR=~/everyanimal/.config/gh`. Звичайний `gh` лишається особистим і цього логіну не бачить |
| **vercel** | `ea-vercel` = Vercel CLI з `--global-config ~/everyanimal/.config/vercel`. Глобального `vercel` на машині навмисно немає |
| **перевірка** | `ea-whoami` — показує git-email, remote, логіни ea-gh / ea-vercel і привʼязку проєкту; код 1 при невідповідності. Викликається з `pre-push` |
| **remote** | `.githooks/pre-push` (в репозиторії, для всіх): пуш лише в `github.com/every-animal/` |
| **Claude Code** | цей репозиторій — окремий проєкт зі своєю памʼяттю; `~/everyanimal/CLAUDE.md` забороняє чужі дані й коннектори; `.claude/settings.local.json` блокує коннектори інших організацій |

Акаунти записані в одному місці: `~/everyanimal/accounts.env`.

### Логін і створення (один раз)

```bash
ea-gh auth login --hostname github.com --git-protocol https --web   # увійти як акаунт hello@everyanimal.org
ea-vercel login                                                      # теж hello@everyanimal.org (через GitHub)
# вписати логіни в ~/everyanimal/accounts.env: EA_GH_USER=…, EA_VERCEL_USER=…
cd ~/everyanimal/vegan-weekend-lviv
ea-gh repo create every-animal/vegan-weekend-lviv --public --source . --push
ea-vercel link --yes --project vegan-weekend-lviv    # створює проєкт; далі Connect Git у дашборді або `ea-vercel git connect`
ea-whoami                                            # усе ✓
```

### Перед кожним пушем / деплоєм

`ea-whoami` запускається сам із `pre-push`. Якщо щось ✗ — не пушити, розібратись.
