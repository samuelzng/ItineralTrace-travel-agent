"""Core agent — Gemini LLM with ReAct tool-calling loop."""

import json
import logging
import threading
from collections.abc import Callable
from datetime import date
from google import genai
from google.genai import types
from config import GEMINI_API_KEY
from tools import TOOL_REGISTRY
from user_memory import load_preferences, format_preferences_for_prompt, format_memories_for_prompt

logger = logging.getLogger(__name__)

MODEL = "gemini-3.1-flash-lite-preview"
MAX_ITERATIONS = 15

_SYSTEM_PROMPT_TEMPLATE = """You are an expert AI travel planning agent. You create detailed, realistic, high-quality itineraries.

TODAY'S DATE: __TODAY__

═══ USER PREFERENCES ═══
__USER_PREFS__

═══ USER MEMORIES ═══
__USER_MEMORIES__

═══ ABSOLUTE RULES ═══

1. REAL PLACES ONLY: Every single place you recommend MUST come from search_places results.
   - Use the EXACT name returned by the search (e.g. "Window of the World", "OCT Loft Creative Culture Park")
   - NEVER invent generic names like "Nanshan Scenic Area" or "Downtown District" or "Local Restaurant"
   - If you need more places, call search_places again with a different query

2. ALWAYS SEARCH FIRST: Call search_places BEFORE recommending any place. No exceptions.
   - Search for different categories separately: "tourist attractions", "popular restaurants", "shopping malls", "museums", etc.
   - Do at least 2-3 different searches to get variety

3. WEATHER-AWARE PLANNING:
   - Call get_weather for the travel dates
   - If rain/thunderstorm is forecast: prioritize INDOOR venues (museums, shopping malls, aquariums, indoor markets)
   - If extreme heat (>35°C): plan outdoor activities for morning/evening only, indoor for midday
   - Mention weather context in activity descriptions (e.g. "Perfect indoor escape from the afternoon rain")

4. REALISTIC TRANSPORT (estimate yourself — no routing tool needed):
   - Based on your knowledge of the city, estimate distance and travel time between consecutive activities.
   - Choose transport mode based on estimated distance:
     • < 1.5 km → "walk" (~15-20 min/km)
     • 1.5–8 km → "subway" or "bus" (~3-5 min/km including wait time)
     • 8–20 km → "subway" or "taxi" (~2-4 min/km)
     • > 20 km → "taxi" or "drive"
   - NEVER use vague "transit" — always specify: "walk", "subway", "bus", or "taxi"
   - If you know real metro line names for the city, mention them (e.g. "Take Line 1")

5. STRUCTURED DAY RHYTHM — MEALS ARE MANDATORY:
   - Morning attraction starting ~09:00 (1.5–2h)
   - LUNCH at the user's preferred lunch time (default 12:00): MUST be a RESTAURANT from search_places results. Search specifically for "popular restaurants" or "best lunch restaurants" to find them. A temple, museum, or park is NOT a meal.
   - Afternoon attraction (1.5–2h)
   - Late afternoon attraction or shopping (1.5–2h)
   - DINNER at the user's preferred dinner time (default 18:00): MUST be a RESTAURANT from search_places results. Same rule — only restaurants for meal slots.
   *** DINNER IS NOT OPTIONAL. Every single day MUST end with a dinner at a RESTAURANT. If you do not have restaurant search results, call search_places("best dinner restaurants", destination) before generating the itinerary. NEVER skip dinner. ***
   - Adjust number of activities based on pace: relaxed=3-4/day, moderate=4-5/day, packed=5-6/day
   - Times should flow realistically: activity end time + transport time = next start time
   - The LAST activity of the day should NOT have transport_to_next (set it to null, not "none")

6. WEATHER-AWARE ACTIVITY SELECTION:
   - Read the planning_hints returned by get_weather and FOLLOW THEM.
   - If rain/storm: pick indoor venues FROM YOUR EXISTING search results. Do NOT call search_places again just for weather — you already have enough results.
   - If extreme heat: outdoor activities ONLY before 10:00 or after 17:00.
   - This is NOT optional — if you recommend an outdoor park on a rainy day, the itinerary is WRONG.

7. QUALITY DESCRIPTIONS: Each activity description should be 1-2 engaging sentences explaining:
   - What makes this place special / what to do there
   - Practical tips (best photo spots, what to order, which exhibits to see)
   - NEVER mention weather negatively in descriptions (no "without getting wet", "escape the rain", etc.). Instead, describe what makes the venue itself great.

═══ PREFERENCE GATHERING ═══

NEVER use emojis — the response will be read aloud by TTS.

*** CRITICAL: CHECK USER PREFERENCES FIRST ***
Look at the USER PREFERENCES section above.
- If it says "No preferences saved yet" → follow the NEW USER flow below.
- If it shows ANY saved preferences (pace, interests, etc.) → SKIP steps 2 and 3 entirely. Go DIRECTLY to step 1 (ask destination & days only). Do NOT ask about pace or interests again — they are already saved.

=== NEW USER FLOW (only when NO preferences are saved) ===

Gather info in MINIMUM messages:

Step 1 — DESTINATION & DAYS:
  - If the user ALREADY specified the destination, do NOT ask for it again.
  - If destination is known but days are missing, ask ONLY: "How many days are you planning for [destination]?"
  - If both destination and days are known, skip step 1 entirely.
  - If neither is known, ask: "Welcome! Where would you like to go and how many days?"
  Then STOP and wait.

Step 2 — PACE & INTERESTS (combine into ONE question, ONLY if no preferences saved):
  "What pace do you prefer (relaxed, moderate, or packed), and what are you most interested in (history, food, nature, shopping, or a mix of everything)?"
  Then STOP and wait.
  Parse BOTH answers from the user's single reply, then call save_user_preferences and IMMEDIATELY start planning.

RULES:
- MAXIMUM 2 questions before planning starts. Never more.
- If the user says "just plan", "skip", "go ahead", "surprise me": IMMEDIATELY use defaults (moderate pace, mix of everything) and START PLANNING.
- Do NOT ask about group size, budget, or dietary.
- NEVER re-ask pace or interests if they are already in USER PREFERENCES.

═══ DATE HANDLING ═══

- If the user specifies dates, use those exact dates.
- If the user says a number of days (e.g. "3-day trip"), start from today.
- If the user says NEITHER dates NOR duration, ask "How many days?" before planning.
- The number of days in the itinerary MUST match the date range exactly.

═══ WORKFLOW ═══

*** SPEED IS CRITICAL — minimize the number of tool-calling rounds ***

1. Check preferences: if none saved, STOP and ask the user (see PREFERENCE GATHERING). Do NOT call tools yet.
2. Clarify dates: if duration/dates not specified, ASK the user. Do NOT guess.
3. ROUND 1 — Call ALL of these IN PARALLEL (same response):
   - search_places("tourist attractions", destination)
   - search_places("best restaurants", destination)
   - get_weather(destination, start_date, end_date)
   - save_user_preferences (if needed)
4. ROUND 2 — Generate the JSON itinerary (estimate transport between places yourself)
   - (Optional) one more search_places if you need more variety

TARGET: Complete planning in 2 tool-calling rounds. Call multiple tools at once whenever possible.

═══ OUTPUT FORMAT ═══

When generating an itinerary, respond with valid JSON:
{
  "destination": "city name",
  "dates": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"},
  "weather_summary": "brief weather + clothing advice",
  "days": [
    {
      "date": "YYYY-MM-DD",
      "weather": {"temp_high": 28, "temp_low": 20, "condition": "Sunny"},
      "activities": [
        {
          "time": "09:00",
          "place": "Exact Place Name From Search",
          "address": "full address from search results",
          "description": "Engaging 1-2 sentence description with practical tips.",
          "image_url": "URL from search_places results (pass through exactly, or empty string)",
          "duration_minutes": 120,
          "transport_to_next": {"mode": "subway", "duration": "18 min", "distance": "6.2 km"}
        }
      ]
    }
  ]
}

For non-planning queries (greetings, general questions), respond naturally in text.

═══ MEMORY ═══

You can remember things about the user by calling save_memory. Use this when the user reveals:
- Personal preferences ("I love spicy food", "I hate museums", "I'm vegetarian")
- Travel companions ("traveling with my wife", "family trip with 2 kids")
- Past experiences ("I've been to Tokyo before", "I visited the Great Wall last year")
- Style preferences ("I prefer luxury hotels", "I like off-the-beaten-path spots")

DO NOT ask "should I remember this?" — just save it naturally when relevant info appears.
DO NOT save obvious or temporary things ("I want to go to Tokyo" is a request, not a memory).
Refer to saved memories when planning to personalize the experience.

═══ IMAGE INPUT ═══

If the user sends an image along with their message, identify the place or landmark in the image.
Then use search_places to find that place and nearby attractions, and offer to plan a trip around it.
If you cannot identify the place, ask the user for more context.
"""

# --- Tool declarations for Gemini ---

TOOL_DECLARATIONS = types.Tool(function_declarations=[
    types.FunctionDeclaration(
        name="search_places",
        description="Search for real places, attractions, or restaurants at a destination. MUST be called before recommending any location.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "query": types.Schema(type="STRING", description="What to search for, e.g. 'top tourist attractions'"),
                "location": types.Schema(type="STRING", description="City or area name, e.g. 'Tokyo'"),
            },
            required=["query", "location"],
        ),
    ),
    types.FunctionDeclaration(
        name="get_weather",
        description="Get weather forecast for a location and date range.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "location": types.Schema(type="STRING", description="City name, e.g. 'Tokyo'"),
                "start_date": types.Schema(type="STRING", description="Start date in YYYY-MM-DD format"),
                "end_date": types.Schema(type="STRING", description="End date in YYYY-MM-DD format"),
            },
            required=["location", "start_date", "end_date"],
        ),
    ),
    types.FunctionDeclaration(
        name="save_user_preferences",
        description="Save the user's travel preferences for future trips. Call this after gathering preferences from the user.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "pace": types.Schema(type="STRING", description="Travel pace: relaxed, moderate, or packed"),
                "lunch_time": types.Schema(type="STRING", description="Preferred lunch time, e.g. '12:00'"),
                "dinner_time": types.Schema(type="STRING", description="Preferred dinner time, e.g. '18:00'"),
                "interests": types.Schema(type="ARRAY", items=types.Schema(type="STRING"), description="List of interests: history, nature, food, shopping, nightlife, art, etc."),
            },
            required=["pace", "interests"],
        ),
    ),
    types.FunctionDeclaration(
        name="save_memory",
        description="Remember something about the user for future personalization. Use when the user reveals preferences, dietary needs, travel companions, past experiences, or style preferences.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "text": types.Schema(type="STRING", description="The memory to save, e.g. 'Prefers vegetarian food' or 'Traveling with wife and 2 kids'"),
            },
            required=["text"],
        ),
    ),
])

# --- Client ---

client = genai.Client(api_key=GEMINI_API_KEY)


class AgentCancelled(Exception):
    """Raised when the agent is cancelled mid-run."""


# Human-readable progress messages for each tool
_TOOL_PROGRESS: dict[str, Callable[[dict], str]] = {
    "search_places": lambda a: f"Searching for {a.get('query', 'places')} in {a.get('location', '')}",
    "get_weather": lambda a: f"Checking weather for {a.get('location', '')}",
    "save_user_preferences": lambda _: "Saving your preferences",
    "save_memory": lambda _: "Remembering that for next time",
}


def run_agent(
    user_message: str,
    conversation_history: list | None = None,
    cancel_event: threading.Event | None = None,
    image_bytes: bytes | None = None,
    image_mime: str = "image/jpeg",
    progress_callback: Callable[[str], None] | None = None,
) -> dict:
    """Run the agent ReAct loop.

    Args:
        user_message: The user's text input.
        conversation_history: Prior turns (list of types.Content). Mutated in place.
        cancel_event: If set, the agent will stop early.
        image_bytes: Optional image data for multimodal input.
        image_mime: MIME type of the image (default jpeg).

    Returns:
        {"text": str, "itinerary": dict | None}
    """
    if conversation_history is None:
        conversation_history = []

    prefs = load_preferences()
    if prefs and (prefs.get("pace") or prefs.get("interests")):
        prefs_text = "PREFERENCES ARE SAVED — do NOT ask about pace or interests.\n" + format_preferences_for_prompt(prefs)
    else:
        prefs_text = "No preferences saved yet. Follow the NEW USER flow to gather them."
    memories_text = format_memories_for_prompt() or "No memories saved yet."
    system_prompt = _SYSTEM_PROMPT_TEMPLATE.replace(
        "__TODAY__", date.today().isoformat()
    ).replace("__USER_PREFS__", prefs_text).replace(
        "__USER_MEMORIES__", memories_text
    )

    # Build user message parts (text + optional image)
    user_parts = [types.Part(text=user_message)]
    if image_bytes:
        user_parts.append(types.Part.from_bytes(data=image_bytes, mime_type=image_mime))

    conversation_history.append(
        types.Content(role="user", parts=user_parts)
    )

    for i in range(MAX_ITERATIONS):
        if cancel_event and cancel_event.is_set():
            raise AgentCancelled()

        logger.debug("Agent iteration %d", i + 1)

        # Progress for LLM thinking rounds
        if progress_callback and i > 0:
            progress_callback("Thinking...")

        # Retry up to 2 times on transient server errors (504, 503, etc.)
        last_err = None
        for attempt in range(3):
            try:
                response = client.models.generate_content(
                    model=MODEL,
                    contents=conversation_history,
                    config=types.GenerateContentConfig(
                        system_instruction=system_prompt,
                        tools=[TOOL_DECLARATIONS],
                        http_options={"timeout": 30_000},
                    ),
                )
                last_err = None
                break
            except Exception as e:
                last_err = e
                err_str = str(e)
                if "504" in err_str or "503" in err_str or "DEADLINE" in err_str or "overloaded" in err_str.lower():
                    logger.warning("Gemini transient error (attempt %d/3): %s", attempt + 1, e)
                    import time as _time
                    _time.sleep(2 * (attempt + 1))
                    continue
                raise
        if last_err:
            logger.error("Gemini failed after 3 attempts: %s", last_err)
            return {"text": "Sorry, the AI service is temporarily busy. Please try again in a moment.", "itinerary": None}

        # Guard against empty/blocked responses (e.g. safety filters)
        if not response.candidates or not response.candidates[0].content:
            logger.warning("Gemini returned empty candidates (safety filter?)")
            return {"text": "I couldn't process that request. Could you rephrase?", "itinerary": None}

        candidate = response.candidates[0]
        parts = candidate.content.parts or []

        # Append the model's response to history
        conversation_history.append(candidate.content)

        # Check if any part has a function call
        function_calls = [p for p in parts if p.function_call]

        if not function_calls:
            # No tool calls — final text response
            if progress_callback and i > 0:
                progress_callback("Putting it all together...")
            text = parts[0].text if parts and parts[0].text else ""
            if not text:
                logger.warning("Gemini returned empty text response")
                return {"text": "I couldn't generate a response. Please try again.", "itinerary": None}
            return _parse_final_response(text)

        # Execute each function call and feed results back
        function_response_parts = []
        for part in function_calls:
            fc = part.function_call
            args = dict(fc.args)
            logger.info("Tool call: %s(%s)", fc.name, args)

            # Send progress update
            if progress_callback:
                msg_fn = _TOOL_PROGRESS.get(fc.name, lambda a: f"Running {fc.name}")
                progress_callback(msg_fn(args))

            tool_fn = TOOL_REGISTRY.get(fc.name)
            if tool_fn is None:
                result = {"error": f"Unknown tool: {fc.name}"}
            else:
                try:
                    result = tool_fn(**args)
                except Exception as e:
                    logger.error("Tool %s failed: %s", fc.name, e)
                    result = {"error": str(e)}

            function_response_parts.append(
                types.Part(function_response=types.FunctionResponse(
                    name=fc.name,
                    response=result,
                ))
            )

            if cancel_event and cancel_event.is_set():
                raise AgentCancelled()

        conversation_history.append(
            types.Content(role="user", parts=function_response_parts)
        )

    # Hit max iterations — return whatever we have
    logger.warning("Agent hit max iterations (%d)", MAX_ITERATIONS)
    return {"text": "I wasn't able to complete the request. Please try a simpler query.", "itinerary": None}


def _parse_final_response(text: str) -> dict:
    """Try to parse the response as JSON itinerary, fall back to plain text."""
    # Try extracting JSON from markdown code blocks
    clean = text.strip()
    if "```json" in clean:
        clean = clean.split("```json", 1)[1].split("```", 1)[0].strip()
    elif "```" in clean:
        clean = clean.split("```", 1)[1].split("```", 1)[0].strip()

    try:
        itinerary = json.loads(clean)
        return {"text": text, "itinerary": itinerary}
    except (json.JSONDecodeError, ValueError):
        return {"text": text, "itinerary": None}


# --- Standalone test ---

if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    history = []

    test_queries = [
        "Hello! Can you help me plan a trip?",
        "Plan a 1-day trip to Tokyo on 2026-04-01. I want to visit 2 tourist spots.",
    ]

    for query in test_queries:
        print(f"\n{'='*60}")
        print(f"USER: {query}")
        print(f"{'='*60}")
        result = run_agent(query, history)
        print(f"\nAGENT: {result['text'][:500]}")
        if result["itinerary"]:
            print(f"\n[Itinerary parsed with {len(result['itinerary'].get('days', []))} day(s)]")
