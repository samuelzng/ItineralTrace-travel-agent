"""Tool registry — exports all tool functions for the agent."""

from tools.places import search_places
from tools.weather import get_weather
from tools.routes import get_directions, get_batch_directions
from user_memory import save_preferences

TOOL_REGISTRY = {
    "search_places": search_places,
    "get_weather": get_weather,
    "get_directions": get_directions,
    "get_batch_directions": get_batch_directions,
    "save_user_preferences": save_preferences,
}

__all__ = ["search_places", "get_weather", "get_directions", "TOOL_REGISTRY"]
