"""User memory — persist travel preferences across sessions."""

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_PREFS_FILE = Path(__file__).parent / "user_preferences.json"

_DEFAULT_PREFS = {
    "pace": "",            # relaxed / moderate / packed
    "group_size": "",      # solo / couple / family / group
    "lunch_time": "12:00",
    "dinner_time": "18:00",
    "interests": [],       # e.g. ["history", "food", "nature", "shopping"]
    "budget": "",          # budget / moderate / luxury
    "dietary": "",         # e.g. "vegetarian", "halal", "no restrictions"
    "notes": "",           # free-form extra preferences
}


def load_preferences() -> dict:
    """Load saved user preferences, or return empty defaults."""
    if not _PREFS_FILE.exists():
        return {}
    try:
        with open(_PREFS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to load preferences: %s", e)
        return {}


def save_preferences(**prefs) -> dict:
    """Merge and save user preferences. Returns the saved prefs."""
    existing = load_preferences()
    # Merge: new values overwrite old, but don't erase fields not mentioned
    for key in _DEFAULT_PREFS:
        if key in prefs and prefs[key]:
            existing[key] = prefs[key]
    try:
        with open(_PREFS_FILE, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
        logger.info("Saved user preferences: %s", existing)
    except OSError as e:
        logger.error("Failed to save preferences: %s", e)
        return {"error": str(e)}
    return {"status": "saved", "preferences": existing}


def format_preferences_for_prompt(prefs: dict) -> str:
    """Format preferences as a readable string for the system prompt."""
    if not prefs:
        return ""
    lines = []
    labels = {
        "pace": "Travel pace",
        "group_size": "Group",
        "lunch_time": "Preferred lunch time",
        "dinner_time": "Preferred dinner time",
        "interests": "Interests",
        "budget": "Budget level",
        "dietary": "Dietary preferences",
        "notes": "Other notes",
    }
    for key, label in labels.items():
        val = prefs.get(key)
        if val:
            if isinstance(val, list):
                val = ", ".join(val)
            lines.append(f"- {label}: {val}")
    return "\n".join(lines)
