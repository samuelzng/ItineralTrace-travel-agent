"""User memory — persist travel preferences and freeform memories."""

import json
import logging
import threading
import uuid
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

_PREFS_FILE = Path(__file__).parent / "user_preferences.json"
_MEMORIES_FILE = Path(__file__).parent / "user_memories.json"
_lock = threading.RLock()

_DEFAULT_PREFS = {
    "pace": "",
    "group_size": "",
    "lunch_time": "12:00",
    "dinner_time": "18:00",
    "interests": [],
    "budget": "",
    "dietary": "",
    "notes": "",
}


# ── Structured preferences (internal, used by save_user_preferences tool) ────

def load_preferences() -> dict:
    """Load saved user preferences, or return empty defaults."""
    with _lock:
        if not _PREFS_FILE.exists():
            return {}
        try:
            with open(_PREFS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to load preferences: %s", e)
            return {}


def _upsert_memory(prefix: str, new_text: str) -> None:
    """Update an existing memory that starts with prefix, or create it."""
    memories = load_memories()
    for m in memories:
        if m["text"].startswith(prefix):
            if m["text"] == new_text:
                return  # already up-to-date
            m["text"] = new_text
            _persist_memories(memories)
            return
    # No existing match — create new
    save_memory(new_text)


def save_preferences(**prefs) -> dict:
    """Merge and save user preferences. Returns the saved prefs."""
    with _lock:
        existing = load_preferences()
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

        # Sync pace and interests into freeform memories so they
        # persist visibly and carry across new trips.
        # Use _upsert_memory to avoid duplicates when prefs change.
        if existing.get("pace"):
            _upsert_memory("Preferred travel pace:", f"Preferred travel pace: {existing['pace']}")
        if existing.get("interests"):
            interests = existing["interests"]
            if isinstance(interests, list):
                interests = ", ".join(interests)
            _upsert_memory("Interests:", f"Interests: {interests}")

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


# ── Freeform memories (user-facing, flexible) ────────────────────────────────

def load_memories() -> list[dict]:
    """Load all saved memories. Returns list of {id, text, created_at}."""
    with _lock:
        if not _MEMORIES_FILE.exists():
            return []
        try:
            with open(_MEMORIES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to load memories: %s", e)
            return []


def _persist_memories(memories: list[dict]) -> None:
    """Write memories list to disk."""
    with open(_MEMORIES_FILE, "w", encoding="utf-8") as f:
        json.dump(memories, f, indent=2, ensure_ascii=False)


def save_memory(text: str) -> dict:
    """Save a freeform memory. Returns the saved memory."""
    with _lock:
        memories = load_memories()
        # Avoid exact duplicates
        for m in memories:
            if m["text"].strip().lower() == text.strip().lower():
                return {"status": "already_exists", "memory": m}
        entry = {
            "id": str(uuid.uuid4())[:8],
            "text": text.strip(),
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        memories.append(entry)
        _persist_memories(memories)
        logger.info("Saved memory: %s", text)
        return {"status": "saved", "memory": entry, "note": "Memory saved. Continue with the current task — do NOT re-ask for information the user already provided."}


def delete_memory(memory_id: str) -> dict:
    """Delete a memory by ID."""
    with _lock:
        memories = load_memories()
        before = len(memories)
        memories = [m for m in memories if m["id"] != memory_id]
        if len(memories) == before:
            return {"status": "not_found"}
        _persist_memories(memories)
        return {"status": "deleted"}


def update_memory(memory_id: str, text: str) -> dict:
    """Update an existing memory's text by ID."""
    with _lock:
        memories = load_memories()
        for m in memories:
            if m["id"] == memory_id:
                m["text"] = text.strip()
                _persist_memories(memories)
                logger.info("Updated memory %s: %s", memory_id, text)
                return {"status": "updated", "memory": m}
        return {"status": "not_found"}


def format_memories_for_prompt() -> str:
    """Format all memories as a readable block for the system prompt."""
    memories = load_memories()
    if not memories:
        return ""
    return "\n".join(f"- {m['text']}" for m in memories)
