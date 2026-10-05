# Деплой

## Як іде публікація

| Подія | Результат | Адреса |
|---|---|---|
| push у будь-яку гілку / PR | **Preview** | `vegan-weekend-lviv-git-<гілка>-….vercel.app` (посилання — у PR від бота Vercel) |
| merge у `main` | **Production** | `vegan-weekend-lviv.vercel.app` → після перемикання домену `www.veganweekend.org` |

Нічого не збирається: Vercel віддає теку `site/` як є (`vercel.json`). `handoff/`, `docs/` тощо в публікацію не потрапляють.

На всіх `*.vercel.app` стоїть `X-Robots-Tag: noindex` (`vercel.json`), щоб пошуковики не індексували тимчасові адреси. На власному домені цього заголовка немає.

Відкат: Vercel → Deployments → попередній Production → *Instant Rollback*.

CLI (`ea-vercel deploy`) — лише якщо Git-інтеграція недоступна. Перед ним — `ea-whoami`.

## Перемикання домену www.veganweekend.org

Перемикає **лише власник**, після його явного «так». Зараз домен обслуговує Webflow (через Cloudflare).

До перемикання (`handoff/README.md`, розділ 6, пункти 1, 3, 10):

- [ ] фавікон «ВВ» забрано з нинішнього сайту й підключено в `site/`
- [ ] зʼясовано з власником, чи є на нинішньому сайті інші адреси, які мають лишитись робочими → редиректи в `vercel.json`
- [ ] ціна квитка актуальна (з 07.10 — 600 грн), тексти погоджені власником
- [ ] теги Google/Meta вантажаться лише після згоди в банері
- [ ] перевірено в Safari (macOS, iOS) і Chrome; `pnpm check` зелений на Production-адресі
- [ ] `og:image` відкривається за адресою з `<head>`

Перемикання: Vercel → Project → Settings → Domains → додати `www.veganweekend.org` і `veganweekend.org` (редирект на `www`) → внести DNS-записи, які покаже Vercel, у DNS домену (Cloudflare). Після — перевірити сертифікат, `og:image`, картку в Telegram/Facebook debugger.
