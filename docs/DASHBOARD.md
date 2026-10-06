# Дашборд продажів

**Адреса:** https://www.veganweekend.org/api/dashboard — **відкрита, без пароля** (рішення власника 06.10.2026): на сторінці немає назви проєкту, пошуковики не індексують. Але репозиторій публічний — хто читає код, знає адресу; там лише загальні цифри, без даних покупців. Щоб закрити — задати `DASHBOARD_PASSWORD`.

Вигляд — за зразком дашборда іншого проєкту власника (темний, тонкі лінії, великі цифри): головне число — скільки оплатили за період, далі воронка, реклама Meta, список по днях. Перемикач: сьогодні / 7 / 30 днів. Сторінка оновлюється сама кожні 5 хв.

| Крок воронки | Звідки |
|---|---|
| Прийшли на сайт | Google Analytics 4 — відвідувачі |
| Натиснули «Купити квиток» | GA4 — подія `begin_checkout` (браузер) |
| Оплатили | GA4 — подія `purchase` (шле сервер з вебхука WayForPay, `api/wayforpay.mjs`) |

Усі три кроки — з одного джерела, тож цифри узгоджені. Оплати є в GA з 06.10.2026 (раніше Make у GA не слав).

**Реклама Meta:** витрачено; ціна квитка з реклами (витрати / покупки, які Meta приписує рекламі); покупок з реклами; витрати на будь-який квиток (витрати / усі оплати).

Чому не API WayForPay: `TRANSACTION_LIST` і `CHECK_STATUS` відповідають «Invalid signature» тим самим ключем, яким успішно перевіряються вебхуки (06.10.2026). Імовірно, для API потрібен окремий доступ — уточнити в WayForPay, якщо колись знадобиться.

Обмеження: Google рахує лише тих, хто дав згоду на cookies (поза ЄС — усіх). Кеш 5 хв; `?fresh` — оновити зараз.

## Підключення

Усі значення — у Vercel → Settings → Environment Variables → Production (або через `ea-vercel env add НАЗВА production --sensitive`), потім redeploy.

**Пароль (необовʼязково):** `DASHBOARD_PASSWORD` — якщо задати, сторінка питатиме його.

**Google Analytics** (`GA4_PROPERTY_ID`, `GA4_SA_JSON`):
1. console.cloud.google.com (під акаунтом, що має доступ до GA) → створити проєкт, напр. `veganweekend-dashboard`.
2. APIs & Services → Library → **Google Analytics Data API** → Enable.
3. IAM & Admin → Service accounts → Create → імʼя `dashboard` → Done → відкрити → Keys → Add key → JSON → завантажиться файл.
4. GA → Admin → Property access management → **+** → email службового акаунта (`dashboard@….iam.gserviceaccount.com`) → роль **Viewer**.
5. GA → Admin → Property details → **Property ID** (число) → `GA4_PROPERTY_ID`.
6. Увесь вміст JSON-файлу → `GA4_SA_JSON`. Файл потім видалити з компʼютера.

**Meta** (`META_AD_ACCOUNT_ID`, `META_ADS_TOKEN`):
1. Ads Manager → номер рекламного кабінету (`act_…` або просто число) → `META_AD_ACCOUNT_ID`.
2. Business settings → Users → System users → користувач (можна той самий, що для Conversions API) → **Assign assets** → Ad accounts → кабінет → право **View performance**.
3. Там само → **Generate new token** → застосунок → дозвіл **ads_read** → токен → `META_ADS_TOKEN`.
   (Новий токен — нові токени не вимикають старі.)

Код — `api/dashboard.mjs`, тести — `tests/dashboard.test.mjs`.
