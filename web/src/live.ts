/** Live-ish India context for the operator demo. Weather is real (Open-Meteo). Demand and Hz are modelled from IST hour + heat — Grid-India has no CORS-open PMU feed. */

export type CityWx = {
  city: string;
  territory: string;
  lat: number;
  lon: number;
  tempC: number | null;
  humidity: number | null;
  fetchedAt: string | null;
};

export const CITIES: CityWx[] = [
  { city: "Bengaluru", territory: "BESCOM", lat: 12.97, lon: 77.59, tempC: null, humidity: null, fetchedAt: null },
  { city: "Pune", territory: "MSEDCL", lat: 18.52, lon: 73.86, tempC: null, humidity: null, fetchedAt: null },
  { city: "Chennai", territory: "TANGEDCO", lat: 13.08, lon: 80.27, tempC: null, humidity: null, fetchedAt: null },
];

export function istNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

export function istClock(d = istNow()): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** Typical Indian system-demand shape, 0–1, 15-minute feel. Evening + afternoon peaks. */
export function loadShape(hour: number, minute = 0): number {
  const t = hour + minute / 60;
  const pts: [number, number][] = [
    [0, 0.48],
    [5, 0.44],
    [7, 0.62],
    [9, 0.74],
    [11, 0.78],
    [13, 0.86],
    [15, 0.93],
    [17, 0.9],
    [19, 0.98],
    [21, 0.88],
    [23, 0.6],
    [24, 0.48],
  ];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, y0] = pts[i - 1];
      const [t1, y1] = pts[i];
      const u = (t - t0) / (t1 - t0);
      return y0 + u * (y1 - y0);
    }
  }
  return 0.5;
}

export function demandIndex(hour: number, minute: number, temps: number[]): number {
  const heat = temps.length
    ? temps.reduce((n, t) => n + Math.max(0, t - 28) * 0.018, 0) / temps.length
    : 0;
  return Math.max(0, Math.min(1, loadShape(hour, minute) + heat));
}

export function modelledHz(demand: number): number {
  // Heavy load pulls frequency a few tens of mHz under 50. Not a PMU.
  const wobble = Math.sin(Date.now() / 700) * 0.012;
  return 50.02 - demand * 0.08 + wobble;
}

export async function fetchLiveWeather(): Promise<CityWx[]> {
  const out: CityWx[] = [];
  await Promise.all(
    CITIES.map(async (c) => {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&current=temperature_2m,relative_humidity_2m&timezone=Asia%2FKolkata`;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          current?: { temperature_2m?: number; relative_humidity_2m?: number };
        };
        out.push({
          ...c,
          tempC: body.current?.temperature_2m ?? null,
          humidity: body.current?.relative_humidity_2m ?? null,
          fetchedAt: new Date().toISOString(),
        });
      } catch {
        out.push({ ...c });
      }
    }),
  );
  return out.sort((a, b) => a.city.localeCompare(b.city));
}

export const DEVICE_LABEL: Record<string, { name: string; city: string; short: string }> = {
  dev_jay_batt: { name: "Jayanagar battery", city: "Bengaluru", short: "Jay batt" },
  dev_jay_tstat: { name: "Jayanagar HVAC", city: "Bengaluru", short: "Jay HVAC" },
  dev_kora_batt: { name: "Koramangala battery", city: "Bengaluru", short: "Kora batt" },
  dev_and_batt: { name: "Andheri battery", city: "Mumbai", short: "And batt" },
  dev_and_tstat: { name: "Andheri HVAC", city: "Mumbai", short: "And HVAC" },
  dev_pune_batt: { name: "Pune battery", city: "Pune", short: "Pune batt" },
  dev_ady_batt: { name: "Adyar battery", city: "Chennai", short: "Adyar batt" },
  dev_ady_tstat: { name: "Adyar HVAC", city: "Chennai", short: "Adyar HVAC" },
};
