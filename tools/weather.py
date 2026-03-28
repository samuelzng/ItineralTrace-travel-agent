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
        timeout=10,
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
            timeout=10,
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
            })

        logger.info("Weather fetched: %d days for %s", len(daily), location)
        return {"location": location, "daily": daily}

    except Exception as e:
        logger.error("get_weather failed: %s", e)
        return {"location": location, "daily": [], "error": str(e)}


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    result = get_weather("Tokyo", "2026-04-01", "2026-04-03")
    for day in result["daily"]:
        print(f"{day['date']}: {day['condition']}, {day['temp_low']}–{day['temp_high']}°C, rain {day['precipitation_mm']}mm")
