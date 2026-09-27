// The weather, from a public web API (open-meteo.com). Shows how a program asks
// to use an API: the first call pops up a permission prompt for that origin.
export const title = "Weather";
export const sizes = [[320, 220], [266, 300]];

const CITIES = [
  ["New York", 40.71, -74.01], ["London", 51.51, -0.13], ["Tokyo", 35.68, 139.69],
  ["Sydney", -33.87, 151.21], ["Nairobi", -1.29, 36.82], ["Lima", -12.05, -77.04],
];

const WEATHER = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle", 61: "rain", 63: "rain", 65: "heavy rain", 71: "snow",
  73: "snow", 75: "heavy snow", 80: "showers", 81: "showers", 82: "heavy showers", 95: "thunderstorms" };

export default function main(sys) {
  const { w, h } = sys.size;
  const { ui } = sys;
  let city = 0;
  let report = "Pick a city.";

  async function load(i) {
    city = i;
    report = "Asking the API...";
    draw();
    const [, lat, lon] = CITIES[i];
    try {
      const res = await sys.net.fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m`,
      );
      const now = JSON.parse(res.body).current;
      report = `${Math.round(now.temperature_2m)} C, ${WEATHER[now.weather_code] ?? "weather code " + now.weather_code}\n` +
        `wind ${Math.round(now.wind_speed_10m)} km/h`;
    } catch (e) {
      report = "Couldn't get the weather: " + e.message;
    }
    draw();
  }

  function draw() {
    sys.ui.setMenus([
      { label: "City", items: CITIES.map(([name], i) => ({ label: name, onClick: () => load(i) })) },
      { label: "View", items: [{ label: "Refresh", onClick: () => load(city) }] },
    ]);
    const cols = w > 300 ? 3 : 2;
    const bw = Math.floor((w - 12 - (cols - 1) * 4) / cols);
    ui.render([
      CITIES.map(([name], i) =>
        ui.button(6 + (i % cols) * (bw + 4), 6 + Math.floor(i / cols) * 22, bw, 18, name, () => load(i))),
      ui.rect(6, h - 80, w - 12, 74, "field", "line"),
      ui.text(14, h - 72, CITIES[city][0], { color: "accent" }),
      ui.text(14, h - 56, report, { w: w - 28 }),
    ]);
  }
  sys.ui.onTheme(draw);
  draw();
}
