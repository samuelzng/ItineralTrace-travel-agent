"""Renderer — normalize agent output into clean structured JSON."""

from __future__ import annotations


def render(agent_result: dict) -> dict:
    """Return structured JSON from agent result. Never returns HTML."""
    itinerary = agent_result.get("itinerary")
    if itinerary:
        return {"type": "itinerary", "data": _normalize_itinerary(itinerary)}
    return {"type": "text", "data": agent_result.get("text", "")}


def _normalize_itinerary(itinerary: dict) -> dict:
    """Ensure every field exists with a safe default — no undefined values."""
    dates = itinerary.get("dates") or {}
    days = itinerary.get("days") or []

    return {
        "destination": itinerary.get("destination") or "Unknown",
        "dates": {
            "start": dates.get("start") or "",
            "end": dates.get("end") or "",
        },
        "weather_summary": itinerary.get("weather_summary") or "",
        "days": [_normalize_day(day, i) for i, day in enumerate(days)],
    }


def _normalize_day(day: dict, index: int) -> dict:
    weather = day.get("weather") or {}
    activities = day.get("activities") or []

    return {
        "date": day.get("date") or f"Day {index + 1}",
        "weather": {
            "temp_high": weather.get("temp_high", "—"),
            "temp_low": weather.get("temp_low", "—"),
            "condition": weather.get("condition") or "",
        },
        "activities": [_normalize_activity(a) for a in activities],
    }


def _normalize_activity(activity: dict) -> dict:
    transport = activity.get("transport_to_next")
    transport_out = None
    if transport:
        transport_out = {
            "mode": transport.get("mode") or "walk",
            "duration": str(transport.get("duration") or ""),
            "distance": str(transport.get("distance") or ""),
        }

    return {
        "time": activity.get("time") or "",
        "place": activity.get("place") or "",
        "address": activity.get("address") or "",
        "description": activity.get("description") or "",
        "duration_minutes": activity.get("duration_minutes") or 0,
        "transport_to_next": transport_out,
    }


# ── Standalone test ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import json

    sample = {
        "itinerary": {
            "destination": "Tokyo",
            "dates": {"start": "2026-04-01", "end": "2026-04-02"},
            "weather_summary": "Mild spring weather, cherry blossoms in full bloom.",
            "days": [
                {
                    "date": "2026-04-01",
                    "weather": {"temp_high": 18, "temp_low": 10, "condition": "Sunny"},
                    "activities": [
                        {
                            "time": "09:00",
                            "place": "Senso-ji Temple",
                            "address": "2-3-1 Asakusa, Taito City",
                            "description": "Explore Tokyo's oldest temple.",
                            "duration_minutes": 90,
                            "transport_to_next": {"mode": "walk", "duration": "20 min", "distance": "1.5 km"},
                        },
                        {
                            "time": "11:00",
                            "place": "Ueno Park",
                            "address": "Uenokoen, Taito City",
                            "description": "Stroll through cherry blossoms.",
                            "duration_minutes": 120,
                            "transport_to_next": None,
                        },
                    ],
                }
            ],
        }
    }
    print(json.dumps(render(sample), indent=2))
