# Оплати → Meta / Google

Квитки продаються через WayForPay (посилання `secure.wayforpay.com/payment/vegan_weekend_lviv`). Саму покупку сторінка не бачить, тож у рекламні системи її передає сервер: **WayForPay → `api/wayforpay.mjs` (Vercel) → Meta Conversions API (+ GA4)**.

## Як працює

1. Після кожної оплати WayForPay шле POST на `https://www.veganweekend.org/api/wayforpay` (налаштування `serviceUrl` у кабінеті WayForPay).
2. Обробник перевіряє підпис `merchantSignature` секретним ключем мерчанта. Без правильного підпису — 403, нічого нікуди не йде.
3. Для оплати квитка — `transactionStatus = Approved` і `orderReference` містить `WFP-SOC-` (той самий фільтр, що був у Make) — шле в Meta подію `Purchase`:
   - `event_id` = номер замовлення → повтори не задвоюються;
   - час — час оплати;
   - email, телефон, імʼя/прізвище — лише SHA-256-хешем;
   - сума, валюта, кількість і назви квитків.
   Якщо задано `GA4_API_SECRET` — ще й `purchase` у Google Analytics.
4. Відповідає WayForPay підписаним `accept`. Якщо Meta не прийняла подію — відповідає 502, і WayForPay повторить запит.

Логи: Vercel → проєкт → Logs, фільтр `wayforpay:`. Видно номер замовлення і статус, без особистих даних.

## Змінні середовища (Vercel → Settings → Environment Variables, Production)

| Змінна | Звідки | Обовʼязкова |
|---|---|---|
| `WAYFORPAY_SECRET_KEY` | кабінет WayForPay → Налаштування магазину → SecretKey | так |
| `META_CAPI_TOKEN` | Meta Events Manager → піксель `1647718446547735` → Settings → Conversions API → Generate access token | так |
| `GA4_API_SECRET` | Google Analytics → Admin → Data streams → потік сайту → Measurement Protocol API secrets → Create | ні |
| `META_TEST_EVENT_CODE` | Events Manager → Test events (на час перевірки; потім видалити) | ні |

Секрети — лише тут. У репозиторії (він публічний) їх немає й не має бути.

## Перехід із Make (06.10.2026)

Старий сценарій Make «Integration Webhooks» (хук «WayForPay incoming») робив те саме, але: ламався на ~19% вебхуків («Source is not valid JSON»), не перевіряв підпис, не відповідав WayForPay коректним `accept`, тримав токен Meta відкритим текстом і вимикається сам після 3 помилок поспіль.

1. Додати змінні середовища (таблиця вище), з `META_TEST_EVENT_CODE`.
2. Задеплоїти (merge у `main`).
3. У WayForPay поміняти `serviceUrl` з адреси Make на `https://www.veganweekend.org/api/wayforpay` (саме з `www`: голий домен перенаправляє, а перенаправлення POST ненадійне).
4. Зробити тестову оплату → Events Manager → Test events: має прийти `Purchase`. Прибрати `META_TEST_EVENT_CODE`.
5. Вимкнути сценарій у Make.
6. **Перевипустити токен Meta**: старий лежить відкритим текстом у сценарії Make — після переходу відкликати його (Business Settings → System users / Events Manager).

Перевірка коду: `pnpm test` (9 тестів у `tests/wayforpay.test.mjs`, запускаються й у CI).
