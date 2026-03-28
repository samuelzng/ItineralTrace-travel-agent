"""Core agent — Gemini LLM with ReAct tool-calling loop."""

import json
import logging
import threading
from datetime import date
from google import genai
from google.genai import types
from config import GEMINI_API_KEY
from tools import TOOL_REGISTRY
from user_memory import load_preferences, format_preferences_for_prompt

logger = logging.getLogger(__name__)

MODEL = "gemini-3.1-flash-lite-preview"
MAX_ITERATIONS = 15

_SYSTEM_PROMPT_TEMPLATE = """You are an expert AI travel planning agent. You create detailed, realistic, high-quality itineraries.

TODAY'S DATE: __TODAY__

═══ USER PREFERENCES ═══
__USER_PREFS__

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

4. REALISTIC TRANSPORT:
   - Use get_batch_directions (NOT get_directions) to compute ALL route legs in ONE call
   - Pass the FULL ADDRESS from search results as origin/destination, never just the place name
   - Include the city parameter for better geocoding accuracy
   - Choose transport mode based on estimated distance:
     • < 1.5 km → "walk"
     • 1.5–5 km → "subway" (most cities have metro)
     • 5–15 km → "subway" or "bus"
     • > 15 km → "taxi" or "drive"
   - NEVER use vague "transit" — always specify: "walk", "subway", "bus", or "taxi"
   - Use the actual duration and distance from batch results
   - If routing fails for some legs, ESTIMATE transport times based on distance and still produce the JSON itinerary. NEVER fall back to plain text just because routing failed.

5. STRUCTURED DAY RHYTHM — MEALS ARE MANDATORY:
   - Morning attraction starting ~09:00 (1.5–2h)
   - LUNCH at the user's preferred lunch time (default 12:00): MUST be a RESTAURANT from search_places results. Search specifically for "popular restaurants" or "best lunch restaurants" to find them. A temple, museum, or park is NOT a meal.
   - Afternoon attraction (1.5–2h)
   - Late afternoon attraction or shopping (1.5–2h)
   - DINNER at the user's preferred dinner time (default 18:00): MUST be a RESTAURANT from search_places results. Same rule — only restaurants for meal slots.
   - Adjust number of activities based on pace: relaxed=3-4/day, moderate=4-5/day, packed=5-6/day
   - Times should flow realistically: activity end time + transport time = next start time
   - The LAST activity of the day should NOT have transport_to_next (set it to null, not "none")

6. QUALITY DESCRIPTIONS: Each activity description should be 1-2 engaging sentences explaining:
   - What makes this place special / what to do there
   - Practical tips (best photo spots, what to order, which exhibits to see)

═══ PREFERENCE GATHERING ═══

NEVER use emojis — the response will be read aloud by TTS.

*** CRITICAL: CHECK USER PREFERENCES FIRST ***
Look at the USER PREFERENCES section above.
- If it says "No preferences saved yet" → follow the NEW USER flow below.
- If it shows ANY saved preferences (pace, interests, etc.) → SKIP steps 2 and 3 entirely. Go DIRECTLY to step 1 (ask destination & days only). Do NOT ask about pace or interests again — they are already saved.

=== NEW USER FLOW (only when NO preferences are saved) ===

Gather preferences ONE question per message in this EXACT order:

Step 1 — DESTINATION & DAYS (always ask this):
  "Welcome! I'd love to help plan your trip. Where would you like to go and how many days are you planning?"
  Then STOP and wait.

Step 2 — PACE (ONLY if no preferences saved):
  "Great choice! What pace do you prefer — relaxed with plenty of downtime, moderate, or packed with as much as possible?"
  Then STOP and wait.

Step 3 — INTERESTS (ONLY if no preferences saved):
  "Got it! What are you most interested in — history and culture, food and local cuisine, nature and outdoors, shopping, or a good mix of everything?"
  Then STOP and wait.

After step 3, call save_user_preferences, then immediately start planning.

RULES:
- Each step is ONE message, ONE question. Never combine steps.
- If the user says "just plan" or "skip", use defaults and proceed.
- Do NOT ask about group size, budget, or dietary.
- NEVER re-ask pace or interests if they are already in USER PREFERENCES.

═══ DATE HANDLING ═══

- If the user specifies dates, use those exact dates.
- If the user says a number of days (e.g. "3-day trip"), start from today.
- If the user says NEITHER dates NOR duration, ask "How many days?" before planning.
- The number of days in the itinerary MUST match the date range exactly.

═══ WORKFLOW ═══

1. Check preferences: if none saved, STOP and ask the user (see PREFERENCE GATHERING). Do NOT call tools yet.
2. Clarify dates: if duration/dates not specified, ASK the user. Do NOT guess.
3. Search: call search_places 2-3 times for different categories (attractions, food, etc.)
4. Weather: call get_weather for the dates
5. Plan: select specific places, arrange in geographic clusters to minimize travel
6. Route: call get_batch_directions ONCE with ALL consecutive place pairs (use full addresses, include city)
7. Generate: output the JSON itinerary

IMPORTANT: You have a maximum of 10 tool call iterations. Budget them wisely:
  - 2-3 search_places calls
  - 1 get_weather call
  - 1 get_batch_directions call (NOT individual get_directions calls)
  - 1 save_user_preferences call (if needed)
  That leaves room for retries if something fails.

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
          "duration_minutes": 120,
          "transport_to_next": {"mode": "subway", "duration": "18 min", "distance": "6.2 km"}
        }
      ]
    }
  ]
}

For non-planning queries (greetings, general questions), respond naturally in text.
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
        name="get_directions",
        description="Get directions between two places. Returns distance and duration. Use get_batch_directions instead when you have multiple legs.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "origin": types.Schema(type="STRING", description="Starting place — use the FULL ADDRESS from search results, not just the name"),
                "destination": types.Schema(type="STRING", description="Ending place — use the FULL ADDRESS from search results, not just the name"),
                "mode": types.Schema(type="STRING", description="Travel mode: walk, drive, bike, subway, bus, or taxi"),
            },
            required=["origin", "destination"],
        ),
    ),
    types.FunctionDeclaration(
        name="get_batch_directions",
        description="Get directions for ALL legs of a trip in one call. MUCH more efficient than calling get_directions multiple times. Use this after planning all activities.",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "legs": types.Schema(
                    type="ARRAY",
                    items=types.Schema(
                        type="OBJECT",
                        properties={
                            "origin": types.Schema(type="STRING", description="Starting place — full address"),
                            "destination": types.Schema(type="STRING", description="Ending place — full address"),
                            "mode": types.Schema(type="STRING", description="Travel mode: walk, subway, bus, taxi, drive"),
                        },
                        required=["origin", "destination"],
                    ),
                    description="List of route legs to compute",
                ),
                "city": types.Schema(type="STRING", description="City name as geocoding hint, e.g. 'Shenzhen'"),
            },
            required=["legs"],
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
])

# --- Client ---

client = genai.Client(api_key=GEMINI_API_KEY)


class AgentCancelled(Exception):
    """Raised when the agent is cancelled mid-run."""


def run_agent(
    user_message: str,
    conversation_history: list | None = None,
    cancel_event: threading.Event | None = None,
) -> dict:
    """Run the agent ReAct loop.

    Args:
        user_message: The user's text input.
        conversation_history: Prior turns (list of types.Content). Mutated in place.
        cancel_event: If set, the agent will stop early.

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
    system_prompt = _SYSTEM_PROMPT_TEMPLATE.replace(
        "__TODAY__", date.today().isoformat()
    ).replace("__USER_PREFS__", prefs_text)

    conversation_history.append(
        types.Content(role="user", parts=[types.Part(text=user_message)])
    )

    for i in range(MAX_ITERATIONS):
        if cancel_event and cancel_event.is_set():
            raise AgentCancelled()

        logger.debug("Agent iteration %d", i + 1)

        response = client.models.generate_content(
            model=MODEL,
            contents=conversation_history,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                tools=[TOOL_DECLARATIONS],
                http_options={"timeout": 30_000},
            ),
        )

        candidate = response.candidates[0]
        # Append the model's response to history
        conversation_history.append(candidate.content)

        # Check if any part has a function call
        function_calls = [p for p in candidate.content.parts if p.function_call]

        if not function_calls:
            # No tool calls — final text response
            text = candidate.content.parts[0].text or ""
            return _parse_final_response(text)

        # Execute each function call and feed results back
        function_response_parts = []
        for part in function_calls:
            fc = part.function_call
            logger.info("Tool call: %s(%s)", fc.name, dict(fc.args))

            tool_fn = TOOL_REGISTRY.get(fc.name)
            if tool_fn is None:
                result = {"error": f"Unknown tool: {fc.name}"}
            else:
                try:
                    result = tool_fn(**dict(fc.args))
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
