# Дашборд продажів

**Адреса:** https://vegan-weekend-lviv.vercel.app/api/dashboard — **лише на домені Vercel** (на `veganweekend.org` — 404; рішення власника 06.10.2026). Відкрита, без пароля і без назви проєкту, пошуковики не індексують. Репозиторій публічний — хто читає код, знає адресу; там лише загальні цифри, без даних покупців. Щоб закрити — задати `DASHBOARD_PASSWORD`.

Вигляд — за зразком дашборда іншого проєкту власника (темний, тонкі лінії, великі цифри): головне число — скільки оплатили за період, далі воронка, реклама Meta, список по днях. Перемикач: сьогодні / 7 / 30 днів. Сторінка оновлюється сама кожні 5 хв.

| Крок воронки | Звідки |
|---|---|
| Прийшли на сайт | Google Analytics 4 — відвідувачі |
| Натиснули «Купити квиток» | GA4 — подія `begin_checkout` (браузер) |
| Оплатили | GA4 — подія `purchase` по кожному замовленню (`transactionId`, `itemsPurchased`): замовлення й квитки; повторені номери рахуються раз; замовлення з подією `refund` і зі списку `DASHBOARD_EXCLUDE_ORDERS` не рахуються |

Усі три кроки — з одного джерела, тож цифри узгоджені. Ресурс GA `425981995` («Кожна тварина») має два потоки — рахується лише потік Vegan Weekend `14373728016` (змінити — `GA4_STREAM_ID`). Оплати є в GA з 06.10.2026 (раніше Make у GA не слав).

**Реклама Meta:** витрачено; ціна квитка з реклами (витрати / покупки, які Meta приписує рекламі); покупок з реклами; витрати на будь-який квиток (витрати / усі оплати).

Чому не API WayForPay: `TRANSACTION_LIST` і `CHECK_STATUS` відповідають «Invalid signature» тим самим ключем, яким успішно перевіряються вебхуки (06.10.2026). Імовірно, для API потрібен окремий доступ — уточнити в WayForPay, якщо колись знадобиться.

Обмеження: Google рахує лише тих, хто дав згоду на cookies (поза ЄС — усіх). Кеш 5 хв; `?fresh` — оновити зараз.

## Підключення

Усі значення — у Vercel → Settings → Environment Variables → Production (або через `ea-vercel env add НАЗВА production --sensitive`), потім redeploy.

**Пароль (необовʼязково):** `DASHBOARD_PASSWORD` — якщо задати, сторінка питатиме його.

**Google Analytics — без ключа** (Workload Identity Federation; JSON-ключі в організації kozhnatvaryna.org заборонені політикою `iam.managed.disableServiceAccountKeyCreation`):
1. Google Cloud, проєкт `veganweekend-dashboard`: увімкнути API **Google Analytics Data**, **IAM Service Account Credentials**, **Security Token Service**.
2. IAM & Admin → Workload Identity Federation → Create pool `vercel` → провайдер OIDC `vercel`: Issuer `https://oidc.vercel.com/every-animal`, Allowed audience `https://vercel.com/every-animal`, mapping `google.subject = assertion.sub`.
3. Службовий акаунт `dashboard` → Principals with access → Grant access → `principal://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/vercel/subject/owner:every-animal:project:vegan-weekend-lviv:environment:production` → роль **Workload Identity User**.
4. GA → Admin → Property access management → email службового акаунта → **Viewer**.
5. Vercel (Production): `GA4_PROPERTY_ID`, `GCP_PROJECT_NUMBER`, `GCP_SERVICE_ACCOUNT_EMAIL` — не секрети. У проєкті Vercel має бути увімкнено OIDC (Settings → Security → Secure backend access with OIDC federation, режим Team) — увімкнено.

Як це працює: кожен запит функції отримує від Vercel коротке OIDC-посвідчення (`x-vercel-oidc-token`); Google STS міняє його на токен, а `iamcredentials.generateAccessToken` — на токен службового акаунта з правом лише читати GA. Діє лише для Production цього проєкту.

**Meta** (`META_AD_ACCOUNT_ID`, `META_ADS_TOKEN`):
1. Ads Manager → номер рекламного кабінету (`act_…` або просто число) → `META_AD_ACCOUNT_ID`.
2. Business settings → Users → System users → користувач (можна той самий, що для Conversions API) → **Assign assets** → Ad accounts → кабінет → право **View performance**.
3. Там само → **Generate new token** → застосунок → дозвіл **ads_read** → токен → `META_ADS_TOKEN`.
   (Новий токен — нові токени не вимикають старі.)
4. Кабінет «Vegan express» спільний для всіх кампаній організації — `META_CAMPAIGN_MATCH = VWL26,vw12lviv` (07.10.2026): кампанії Веган Вікенду у Львові мають у назві мітку **VWL26** (Vegan Weekend Lviv 2026), напр. `VWL26 · Квитки · холодна`, або вже наявну **vw12lviv** (тизери `teaser_vw12lviv_…`). Наступного року — `VWL27`. Без нього дашборд рахує всі кампанії і показує їхній список із попередженням.

Код — `api/dashboard.mjs`, тести — `tests/dashboard.test.mjs`.

## Чому в Meta Events Manager покупок більше, ніж оплат

«Усього подій» рахує, скільки подій **надійшло**, разом із дублікатами. 06.10.2026 там було 7 при 3 оплатах: старий сценарій Make відповідав WayForPay порожньою відповіддю, і WayForPay повторював те саме повідомлення (графік 2 / 10 / 20 хв) — Make щоразу слав Purchase. Meta зводить події з однаковим `event_id` (= номер замовлення) в одну — в Ads Manager і атрибуції рахується одна покупка. Наш обробник відповідає підписаним `accept`, тож повторів більше немає (крім випадку, коли Meta не прийняла подію — тоді повтор потрібен і теж зведеться в одну).

## Квитки й повернення

- Головне число — **квитки**: кількість приходить від WayForPay у складі замовлення (`products[].count`), обробник передає її в GA як `quantity`.
- **Повернення**: WayForPay шле повідомлення зі статусом `Refunded` → `api/wayforpay.mjs` шле в GA подію `refund` з тим самим `transaction_id` → дашборд не рахує це замовлення й його квитки, показує «повернено N». У Meta повернення не передаються (немає такої події).
- **Ручні виключення**: `DASHBOARD_EXCLUDE_ORDERS` — номери замовлень через кому (тестові покупки; повернення до 07.10.2026, коли обробник їх ще не обробляв).
