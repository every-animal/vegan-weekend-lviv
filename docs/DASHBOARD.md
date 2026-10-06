# Дашборд продажів

**Адреса:** https://www.veganweekend.org/api/dashboard — за паролем (логін будь-який, пароль — `DASHBOARD_PASSWORD`). Пошуковики не індексують.

Воронка за період (сьогодні / 7 / 30 днів):

| Крок | Звідки |
|---|---|
| Прийшли на сайт | Google Analytics 4 (Data API) |
| Натиснули «Купити квиток» | Google Analytics 4 (подія `begin_checkout`) |
| Оплатили | WayForPay (API, кнопка `12700913` — Львів, лише успішні) |

Між кроками — % переходу; окремо — від відвідувача до оплати.

**Реклама Meta:** скільки витрачено; ціна квитка з реклами (витрати / покупки, які Meta приписує рекламі); витрати на будь-який проданий квиток (витрати / усі квитки за період). Під цим — таблиця по днях.

Детальні продажі (суми, по днях) — у кабінеті WayForPay, тут їх навмисно немає.

Обмеження:
- WayForPay не віддає кількість квитків у замовленні — рахуємо з суми (500 грн до 06.10, 600 грн з 07.10; ціни в `api/dashboard.mjs`, `PRICE`). Замовлення й сума — точні.
- Google рахує лише тих, хто дав згоду на cookies.
- Дані кешуються на 5 хв; `?fresh` в адресі — оновити зараз.

## Підключення

Усі значення — у Vercel → Settings → Environment Variables → Production (або через `ea-vercel env add НАЗВА production --sensitive`), потім redeploy.

**Пароль:** `DASHBOARD_PASSWORD`.

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
