"""Tool registry — exports all tool functions for the agent."""

from tools.places import search_places
from tools.weather import get_weather
from user_memory import save_preferences, save_memory

TOOL_REGISTRY = {
    "search_places": search_places,
    "get_weather": get_weather,
    "save_user_preferences": save_preferences,
    "save_memory": save_memory,
}

__all__ = ["search_places", "get_weather", "TOOL_REGISTRY"]
