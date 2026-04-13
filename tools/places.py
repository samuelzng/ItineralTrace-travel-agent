"""Places search tool using Tavily API."""

import logging
import re
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

        # Collect all available images with their URLs (pre-filtered)
        top_images = response.get("images") or []
        all_image_urls = []
        for img in top_images:
            url = img if isinstance(img, str) else (img.get("url", "") if isinstance(img, dict) else "")
            if url and not _is_bad_image_url(url):
                all_image_urls.append(url)

        places = []
        used_images = set()
        for result in response.get("results", []):
            name = result.get("title") or "Unknown"

            # 1. Per-result image (most reliable, but still filter junk)
            image_url = result.get("image_url") or ""
            if image_url and _is_bad_image_url(image_url):
                image_url = ""

            # 2. Match top-level images by checking if place name keywords appear in URL
            if not image_url:
                image_url = _match_image_to_place(name, all_image_urls, used_images)

            if image_url:
                used_images.add(image_url)

            places.append({
                "name": name,
                "description": (result.get("content") or "")[:150],
                "address": _extract_address(result.get("content", ""), location),
                "image_url": image_url,
            })

        # Round-robin: assign remaining top-level images to places that have none
        remaining = [u for u in all_image_urls if u not in used_images]
        if remaining:
            ri = 0
            for p in places:
                if not p["image_url"] and ri < len(remaining):
                    p["image_url"] = remaining[ri]
                    ri += 1

        summary = response.get("answer", "")
        img_count = sum(1 for p in places if p["image_url"])
        logger.info("Found %d places (%d with images) for '%s' in %s",
                     len(places), img_count, query, location)
        return {"places": places, "summary": summary}

    except Exception as e:
        logger.error("search_places failed: %s", e)
        return {"places": [], "error": str(e)}


def _is_bad_image_url(url: str) -> bool:
    """Filter out URLs that are likely not useful photos."""
    low = url.lower()
    bad_patterns = (
        "favicon", "logo", ".svg", ".ico", "1x1", "pixel",
        "badge", "icon", "button", "banner", "avatar",
        "gravatar", "sprite", "placeholder",
        # UGC / low-quality sources
        "pinterest.com", "pinimg.com",
        "tripadvisor.com/img2",  # tiny review thumbnails
        "facebook.com", "fbcdn.net",
        "instagram.com",
        # Stock / watermarked
        "shutterstock", "gettyimages", "istockphoto", "dreamstime",
        "depositphotos", "123rf",
    )
    return any(p in low for p in bad_patterns)


def _has_cjk(text: str) -> bool:
    """Check if text contains CJK characters."""
    return bool(re.search(r'[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]', text))


def _match_image_to_place(name: str, image_urls: list, used: set) -> str:
    """Find the best image URL for a place by keyword matching.

    For CJK place names, falls back to the first unused image since
    URL-keyword matching doesn't work for non-Latin scripts.
    Prefers high-quality sources (wikimedia, official sites) over blogs.
    """
    # Extract meaningful keywords from the place name (skip short/common words)
    stop = {"the", "of", "in", "at", "and", "a", "an", "to", "for", "is", "&"}
    keywords = [
        w.lower() for w in re.split(r'[\s\-/,.:()]+', name)
        if len(w) > 2 and w.lower() not in stop
    ]

    available = [u for u in image_urls if u not in used and not _is_bad_image_url(u)]

    # For CJK names, keyword-in-URL matching won't work — assign first available
    if _has_cjk(name) and not keywords:
        return available[0] if available else ""

    best_url, best_score = "", 0.0
    for url in available:
        url_lower = url.lower()
        score = sum(1 for kw in keywords if kw in url_lower)
        if score < 1:
            continue
        # Boost quality sources
        score += 0.5 * any(q in url_lower for q in (
            "wikimedia", "wikipedia", "upload.wikimedia",
            ".gov", ".edu", ".museum",
        ))
        # Prefer jpg/png (likely photos) over webp/gif
        score += 0.2 * any(url_lower.endswith(ext) for ext in (".jpg", ".jpeg", ".png"))
        if score > best_score:
            best_score = score
            best_url = url

    # If keyword matching failed but we have CJK in the name, use first available
    if not best_url and _has_cjk(name) and available:
        return available[0]

    return best_url if best_score >= 1 else ""


def _extract_address(content: str, location: str) -> str:
    """Best-effort address extraction from content snippet."""
    # Only match patterns that look like real street addresses (must have a number)
    patterns = [
        r'\d+[-–]\d+[-–]\d+\s+[A-Za-z\u3000-\u9fff]+',  # Japanese-style: 2-3-1 Asakusa
        r'\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Lane|Way)',
        # US-style: City, State ZIP (requires zip code to avoid false positives like "Lonely Planet, France")
        r'[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\s+\d{5}',
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

