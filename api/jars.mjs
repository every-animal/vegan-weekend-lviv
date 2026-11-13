/* «Банки» — https://vegan-weekend-lviv.vercel.app/api/jars: збори в банках Monobank наживо, окремо від аналітики квитків.
   Уся логіка — api/_jars.mjs (дані) і api/dashboard.mjs → jarsHandle (сторінка). */
import { jarsHandle } from './dashboard.mjs';
export function GET(request) { return jarsHandle(request); }
