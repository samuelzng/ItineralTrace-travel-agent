"""Routing tool — OSRM for walk/bike/drive, estimated transit via OSRM fallback."""

import logging
import threading
import time
import requests

logger = logging.getLogger(__name__)

# Geocoding cache — avoids repeated Nominatim lookups and rate limits
_geocode_cache: dict[str, tuple[float, float]] = {}
_last_nominatim_call = 0.0
_nominatim_lock = threading.Lock()

# Modes that get an estimated transit result via OSRM driving fallback
_TRANSIT_MODES = {"transit", "subway", "bus"}

# ── OSRM (walk / bike / drive — free, no key) ───────────────────────────────

OSRM_PROFILES = {
    "walk":  ("routed-foot", "foot"),
    "bike":  ("routed-bike", "bike"),
    "drive": ("routed-car",  "driving"),
}


def _geocode(location: str, city_hint: str = "") -> tuple[float, float]:
    """Resolve address/place name to lat/lng via Nominatim (cached, rate-limited)."""
    global _last_nominatim_call
    import re

    cache_key = f"{location}|{city_hint}".lower()
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    queries = []
    if city_hint:
        queries.append(f"{location}, {city_hint}")
    queries.append(location)
    # Strip leading numbers (street numbers often confuse Nominatim for Chinese addresses)
    stripped = re.sub(r'^\d+\s+', '', location)
    if stripped != location:
        queries.append(f"{stripped}, {city_hint}" if city_hint else stripped)
    # Try just the district + city
    district_match = re.search(r'([\w\s]+District)', location)
    if district_match and city_hint:
        queries.append(f"{district_match.group(1)}, {city_hint}")

    for query in queries:
        try:
            # Nominatim rate limit: max 1 req/sec (lock ensures no concurrent violation)
            with _nominatim_lock:
                elapsed = time.time() - _last_nominatim_call
                if elapsed < 1.1:
                    time.sleep(1.1 - elapsed)
                _last_nominatim_call = time.time()

            resp = requests.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": query, "format": "json", "limit": 1},
                headers={"User-Agent": "TravelAgentApp/1.0"},
                timeout=10,
            )
            resp.raise_for_status()
            results = resp.json()
            if results:
                coords = (float(results[0]["lat"]), float(results[0]["lon"]))
                _geocode_cache[cache_key] = coords
                return coords
        except requests.RequestException:
            continue
    raise ValueError(f"Cannot geocode: {location}")


def _route_osrm(origin: str, destination: str, mode: str, city_hint: str = "") -> dict:
    """Compute a single route leg via OSRM."""
    orig_lat, orig_lng = _geocode(origin, city_hint)
    dest_lat, dest_lng = _geocode(destination, city_hint)

    subdomain, profile = OSRM_PROFILES.get(mode, ("routed-car", "driving"))
    coords = f"{orig_lng},{orig_lat};{dest_lng},{dest_lat}"
    resp = requests.get(
        f"https://routing.openstreetmap.de/{subdomain}/route/v1/{profile}/{coords}",
        params={"overview": "false"},
        headers={"User-Agent": "TravelAgentApp/1.0"},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()

    if data.get("code") != "Ok" or not data.get("routes"):
        raise ValueError(f"OSRM returned no route: {data.get('message', '')}")

    route = data["routes"][0]
    distance_km = round(route["distance"] / 1000, 2)
    duration_min = round(route["duration"] / 60)

    return {
        "origin": origin,
        "destination": destination,
        "mode": mode,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "summary": f"{duration_min} min by {mode} ({distance_km} km)",
    }


# ── Unified routing ──────────────────────────────────────────────────────────

def _route_single(origin: str, destination: str, mode: str, city_hint: str = "") -> dict:
    """Route a single leg via OSRM; transit modes get an estimated result."""
    # OSRM for walk/bike/drive; transit modes fall back to drive estimate
    result = _route_osrm(origin, destination, mode if mode in OSRM_PROFILES else "drive", city_hint)
    # If this was a transit mode, adjust the estimate and mark it
    if mode in _TRANSIT_MODES:
        result["mode"] = mode
        result["duration_min"] = round(result["duration_min"] * 1.5)
        result["summary"] = f"~{result['duration_min']} min by {mode} ({result['distance_km']} km) [estimated]"
        result["estimated"] = True
    return result


def get_directions(origin: str, destination: str, mode: str = "walk") -> dict:
    """Get directions between two places.

    Args:
        origin:      Starting place name or address
        destination: Ending place name or address
        mode:        "walk" | "drive" | "bike" | "subway" | "bus" | "transit" | "taxi"

    Returns:
        {"origin": str, "destination": str, "mode": str,
         "distance_km": float, "duration_min": int, "summary": str}
    """
    logger.debug("get_directions: %s → %s (%s)", origin, destination, mode)
    try:
        result = _route_single(origin, destination, mode)
        logger.info("Route: %s", result["summary"])
        return result
    except Exception as e:
        logger.error("get_directions failed: %s", e)
        return {
            "origin": origin,
            "destination": destination,
            "mode": mode,
            "distance_km": None,
            "duration_min": None,
            "summary": f"Routing unavailable: {e}",
            "error": str(e),
        }


def get_batch_directions(legs: list[dict], city: str = "") -> dict:
    """Get directions for multiple legs in one call.

    Args:
        legs: List of {"origin": str, "destination": str, "mode": str}
        city: City name used as geocoding hint (e.g. "Shenzhen")

    Returns:
        {"routes": [<route dict per leg>], "failed": [<failed leg indices>]}
    """
    logger.debug("get_batch_directions: %d legs, city=%s", len(legs), city)
    routes = []
    failed = []
    for i, leg in enumerate(legs):
        origin = leg.get("origin", "")
        destination = leg.get("destination", "")
        mode = leg.get("mode", "walk")
        try:
            result = _route_single(origin, destination, mode, city_hint=city)
            logger.info("Batch leg %d: %s", i, result["summary"])
            routes.append(result)
        except Exception as e:
            logger.warning("Batch leg %d failed: %s", i, e)
            routes.append({
                "origin": origin,
                "destination": destination,
                "mode": mode,
                "distance_km": None,
                "duration_min": None,
                "summary": f"Routing unavailable: {e}",
                "error": str(e),
            })
            failed.append(i)
    return {"routes": routes, "failed": failed}


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    # Test walk (OSRM)
    r1 = get_directions("Shinjuku, Tokyo", "Shibuya, Tokyo", mode="walk")
    print("Walk:", r1["summary"])
    # Test transit (estimated via OSRM)
    r2 = get_directions("Shinjuku, Tokyo", "Asakusa, Tokyo", mode="subway")
    print("Subway:", r2["summary"])
