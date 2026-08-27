// Free driving-distance/duration lookup for two US locations, e.g.
// "Aurora, Colorado" -> "Denver, CO". Uses OpenStreetMap's public Nominatim
// geocoder to turn place names into coordinates, then OSRM's public routing
// demo server to get a real driving route between them.
//
// Both services are free public demo instances with modest rate limits —
// fine for occasional lookups, not meant for heavy/bulk use.

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(
    query
  )}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BroadcastHub/1.0 (dispatch distance lookup)' },
  });
  if (!res.ok) throw new Error('Сервис геокодирования временно недоступен.');
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`Не удалось найти локацию: "${query}"`);
  }
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: data[0].display_name };
}

async function getDistance(fromQuery, toQuery) {
  const [from, to] = await Promise.all([geocode(fromQuery), geocode(toQuery)]);

  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Сервис построения маршрута временно недоступен.');
  const data = await res.json();
  if (data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes.length) {
    throw new Error('Не удалось построить автомобильный маршрут между этими точками.');
  }

  const route = data.routes[0];
  const miles = route.distance / 1609.344;
  const totalMinutes = route.duration / 60;

  return {
    fromLabel: from.label,
    toLabel: to.label,
    miles: Math.round(miles * 10) / 10,
    hours: Math.floor(totalMinutes / 60),
    minutes: Math.round(totalMinutes % 60),
  };
}

module.exports = { getDistance };
