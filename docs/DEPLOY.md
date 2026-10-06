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

- [x] фавікон «ВВ» забрано з нинішнього сайту й підключено в `site/`
- [x] інших адрес на старому сайті немає (одна сторінка, без sitemap) — редиректи не потрібні
- [ ] ціна квитка актуальна (з 07.10 — 600 грн), тексти погоджені власником
- [x] Google Analytics — лише на домені й лише за згодою (Meta Pixel — коли буде ID) в банері
- [ ] перевірено в Safari (macOS, iOS) і Chrome; `pnpm check` зелений на Production-адресі
- [ ] `og:image` відкривається за адресою з `<head>`

Перемикання (06.10.2026). Домени в Vercel додано: `www.veganweekend.org` — основний, `veganweekend.org` — 308 на `www`. DNS — у **name.com** (реєстратор; Cloudflare лише перед Webflow):

| Тип | Host | Значення |
|---|---|---|
| CNAME | `www` | `5ae272424450a34e.vercel-dns-017.com` |
| A | `@` | `216.198.79.1` |
| A | `@` | `64.29.17.1` |

Старі записи Webflow (`cdn.webflow.com`, `198.202.211.1`, AAAA `2620:cb:2000::1`) прибрати; MX / TXT не чіпати. Після — перевірити сертифікат, редирект з голого домену, `og:image`, `pnpm check https://www.veganweekend.org/`, картку в Telegram / Facebook Sharing Debugger.
