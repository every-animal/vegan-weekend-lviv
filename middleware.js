/* Країна відвідувача для банера cookies (рішення власника 06.10.2026).
   Vercel визначає країну за IP (заголовок x-vercel-ip-country); кладемо її в cookie vw-geo,
   і сторінка показує банер лише відвідувачам з ЄЄЗ, Великої Британії та Швейцарії.
   Працює тільки для самої сторінки (matcher) — файли й картинки не зачіпає.
   x-vw-test-geo — підміна країни для handoff/checks/behaviour.js (так людина може змінити хіба що власний банер).
   Відповідь з x-middleware-next = «пропустити запит далі» (те саме робить next() з @vercel/functions). */
export const config = { matcher: ['/'] };

export default function middleware(request) {
  const c = (request.headers.get('x-vw-test-geo') || request.headers.get('x-vercel-ip-country') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  const headers = { 'x-middleware-next': '1' };
  if (c) headers['set-cookie'] = `vw-geo=${c}; Path=/; Max-Age=86400; SameSite=Lax; Secure`;
  return new Response(null, { headers });
}
