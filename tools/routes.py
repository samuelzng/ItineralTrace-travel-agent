"""Routing tool using OSRM (free, no API key needed)."""

import logging
import requests

logger = logging.getLogger(__name__)

# routing.openstreetmap.de uses separate subdomains per profile
OSRM_PROFILES = {
    "walk":    ("routed-foot",  "foot"),
    "bike":    ("routed-bike",  "bike"),
    "drive":   ("routed-car",   "driving"),
    "transit": ("routed-car",   "driving"),  # no transit — use driving as estimate
}


def _geocode(location: str, city_hint: str = "") -> tuple[float, float]:
    """Resolve address/place name to lat/lng via Nominatim.

    Tries multiple strategies: exact query, with city hint, structured search,
    and progressively simplified versions of the address.
    """
    queries = [location]
    if city_hint:
        queries.append(f"{location}, {city_hint}")
    # Strip leading numbers (street numbers often confuse Nominatim for Chinese addresses)
    import re
    stripped = re.sub(r'^\d+\s+', '', location)
    if stripped != location:
        queries.append(f"{stripped}, {city_hint}" if city_hint else stripped)
    # Try just the district + city (e.g. "Nanshan District, Shenzhen")
    district_match = re.search(r'([\w\s]+District)', location)
    if district_match and city_hint:
        queries.append(f"{district_match.group(1)}, {city_hint}")

    for query in queries:
        try:
            resp = requests.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": query, "format": "json", "limit": 1},
                headers={"User-Agent": "TravelAgentApp/1.0"},
                timeout=10,
            )
            resp.raise_for_status()
            results = resp.json()
            if results:
                return float(results[0]["lat"]), float(results[0]["lon"])
        except requests.RequestException:
            continue
    raise ValueError(f"Cannot geocode: {location}")


def _route_single(origin: str, destination: str, mode: str, city_hint: str = "") -> dict:
    """Compute a single route leg between two places."""
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

    if mode in ("transit", "subway", "bus"):
        duration_min = round(duration_min * 1.5)

    return {
        "origin": origin,
        "destination": destination,
        "mode": mode,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "summary": f"{duration_min} min by {mode} ({distance_km} km)",
    }


def get_directions(origin: str, destination: str, mode: str = "walk") -> dict:
    """Get directions between two places.

    Args:
        origin:      Starting place name or address
        destination: Ending place name or address
        mode:        "walk" | "drive" | "bike" | "transit"

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
    result = get_directions("Shinjuku, Tokyo", "Shibuya, Tokyo", mode="walk")
    print(result["summary"])
