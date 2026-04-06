"""Weather tool using Open-Meteo (free, no API key needed)."""

import logging
import requests
from datetime import datetime, date
from config import OPENMETEO_BASE_URL, GEOCODING_BASE_URL

logger = logging.getLogger(__name__)

WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow",
    80: "Light showers", 81: "Showers", 82: "Heavy showers",
    95: "Thunderstorm", 99: "Thunderstorm with hail",
}


def _geocode(location: str) -> tuple[float, float]:
    """Resolve city name to lat/lng."""
    resp = requests.get(
        f"{GEOCODING_BASE_URL}/search",
        params={"name": location, "count": 1, "language": "en", "format": "json"},
        timeout=5,
    )
    resp.raise_for_status()
    results = resp.json().get("results", [])
    if not results:
        raise ValueError(f"Cannot geocode location: {location}")
    return results[0]["latitude"], results[0]["longitude"]


def get_weather(location: str, start_date: str, end_date: str) -> dict:
    """Get weather forecast for a location and date range.

    Args:
        location: City name (e.g. "Tokyo")
        start_date: ISO date string "YYYY-MM-DD"
        end_date:   ISO date string "YYYY-MM-DD"

    Returns:
        {"location": str, "daily": [{"date": str, "temp_high": float,
          "temp_low": float, "condition": str, "precipitation_mm": float}]}
    """
    logger.debug("get_weather: %s from %s to %s", location, start_date, end_date)
    try:
        lat, lng = _geocode(location)
        resp = requests.get(
            f"{OPENMETEO_BASE_URL}/forecast",
            params={
                "latitude": lat,
                "longitude": lng,
                "daily": "temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum",
                "start_date": start_date,
                "end_date": end_date,
                "timezone": "auto",
            },
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()["daily"]

        daily = []
        for i, d in enumerate(data["time"]):
            daily.append({
                "date": d,
                "temp_high": data["temperature_2m_max"][i],
                "temp_low": data["temperature_2m_min"][i],
                "condition": WMO_CODES.get(data["weathercode"][i], "Unknown"),
                "precipitation_mm": data["precipitation_sum"][i],
                "_weathercode": data["weathercode"][i],
            })

        hints = _generate_planning_hints(daily)
        logger.info("Weather fetched: %d days for %s (%d hints)", len(daily), location, len(hints))
        return {"location": location, "daily": daily, "planning_hints": hints}

    except Exception as e:
        logger.error("get_weather failed: %s", e)
        return {"location": location, "daily": [], "error": str(e)}


_RAIN_CODES = {51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 99}
_SNOW_CODES = {71, 73, 75}
_FOG_CODES = {45, 48}


def _generate_planning_hints(daily: list[dict]) -> list[str]:
    """Generate weather-aware planning hints for each day."""
    hints = []
    for day in daily:
        d = day["date"]
        code = day.get("_weathercode")
        precip = day.get("precipitation_mm", 0)
        high = day.get("temp_high", 25)
        low = day.get("temp_low", 15)
        condition = day.get("condition", "")

        # Rain / storms
        if precip > 10 or code in {63, 65, 81, 82, 95, 99}:
            hints.append(
                f"{d}: Heavy rain/storm expected ({condition}, {precip}mm). "
                "MUST pick indoor venues from your existing search results for this day: museums, shopping malls, aquariums. "
                "Do NOT do an extra search — use what you already have."
            )
        elif precip > 2 or code in _RAIN_CODES:
            hints.append(
                f"{d}: Rain likely ({condition}, {precip}mm). "
                "Prefer indoor places from your existing search results for this day."
            )

        # Snow
        if code in _SNOW_CODES:
            hints.append(
                f"{d}: Snow expected ({condition}). "
                "Suggest hot springs, indoor attractions, warm cafes. Warn about slippery conditions."
            )

        # Extreme heat
        if high > 35:
            hints.append(
                f"{d}: Extreme heat ({high}°C). "
                "Schedule outdoor activities ONLY before 10:00 or after 17:00. "
                "Midday must be indoors (malls, museums, air-conditioned venues)."
            )
        elif high > 32:
            hints.append(
                f"{d}: Hot weather ({high}°C). "
                "Prefer shaded or air-conditioned venues during 12:00-15:00."
            )

        # Cold
        if low < 0:
            hints.append(
                f"{d}: Freezing temperatures (low {low}°C). "
                "Prioritize indoor and heated venues. Suggest warm clothing."
            )
        elif low < 5:
            hints.append(
                f"{d}: Cold weather (low {low}°C). "
                "Mix indoor and outdoor; suggest warm indoor stops between outdoor activities."
            )

        # Fog
        if code in _FOG_CODES:
            hints.append(
                f"{d}: Foggy conditions. "
                "Avoid scenic viewpoints (low visibility). Suggest street-level or indoor activities."
            )

    if not hints:
        hints.append("Weather looks good for all days — no special constraints.")

    return hints


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    result = get_weather("Tokyo", "2026-04-01", "2026-04-03")
    for day in result["daily"]:
        print(f"{day['date']}: {day['condition']}, {day['temp_low']}–{day['temp_high']}°C, rain {day['precipitation_mm']}mm")
    print("\nPlanning hints:")
    for hint in result.get("planning_hints", []):
        print(f"  - {hint}")
