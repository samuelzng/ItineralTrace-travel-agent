"""Places search tool using Tavily API."""

import logging
from tavily import TavilyClient
from config import TAVILY_API_KEY

logger = logging.getLogger(__name__)
_client = TavilyClient(api_key=TAVILY_API_KEY)


def search_places(query: str, location: str, max_results: int = 5) -> dict:
    """Search for real places, attractions, or restaurants at a destination.

    Returns:
        {"places": [{"name": str, "address": str, "description": str,
                     "url": str, "rating": str}]}
    """
    

    search_query = f"{query} in {location} travel attractions address"
    logger.debug("Tavily search: %s", search_query)

    try:
        response = _client.search(
            query=search_query,
            search_depth="advanced",
            max_results=max_results,
            include_answer=True,
            include_images=True,
        )

        # Build a map of per-result image URLs (from result metadata)
        # Tavily also returns a top-level "images" list
        top_images = response.get("images") or []

        places = []
        for idx, result in enumerate(response.get("results", [])):
            # Try per-result image first, fall back to top-level images list
            image_url = ""
            if result.get("image_url"):
                image_url = result["image_url"]
            elif idx < len(top_images):
                img = top_images[idx]
                image_url = img if isinstance(img, str) else (img.get("url", "") if isinstance(img, dict) else "")

            places.append({
                "name": result.get("title", "Unknown"),
                "description": result.get("content", "")[:150],
                "address": _extract_address(result.get("content", ""), location),
                "image_url": image_url,
            })

        summary = response.get("answer", "")
        logger.info("Found %d places for '%s' in %s", len(places), query, location)
        return {"places": places, "summary": summary}

    except Exception as e:
        logger.error("search_places failed: %s", e)
        return {"places": [], "error": str(e)}


def _extract_address(content: str, location: str) -> str:
    """Best-effort address extraction from content snippet."""
    import re
    # Look for common address patterns (street number + name, or district/ward patterns)
    patterns = [
        r'\d+[-–]\d+[-–]\d+\s+[A-Za-z\u3000-\u9fff]+',  # Japanese-style: 2-3-1 Asakusa
        r'\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Lane|Way)',
        r'[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:,\s*[A-Z]{2}\s+\d{5})?',
    ]
    for pat in patterns:
        match = re.search(pat, content)
        if match:
            return match.group(0).strip()
    return location


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    result = search_places("top tourist attractions", "Tokyo")
    for p in result["places"]:
        print(f"- {p['name']}: {p['description'][:100]}")

