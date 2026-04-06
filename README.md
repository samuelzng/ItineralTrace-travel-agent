# AI Travel Agent

A multimodal AI travel planning agent built for CSCI3280 (Introduction to Multimedia). Accepts voice, text, and image input; calls live APIs to find real places; and returns a structured itinerary with text-to-speech narration.

## Features

- **Voice + Text I/O** — speak or type your request; responses are played back via TTS
- **Image input** — upload or paste (Ctrl+V) a photo of a landmark; the agent identifies it and plans around it
- **Attraction photos** — itinerary activity cards show real photos from search results
- **ReAct agent loop** — Gemini LLM reasons step-by-step and calls tools until the itinerary is complete
- **Zero hallucination** — every recommended place comes from a live Tavily web search
- **Weather-aware** — checks the 16-day forecast and adapts activity suggestions accordingly
- **Realistic routing** — computes walking/transit distances between all stops in one batch call
- **Flexible memory** — agent learns preferences naturally from conversation (dietary needs, travel companions, style); user can view, add, and delete memories in the sidebar
- **Multiple itineraries per trip** — ask for a second destination in the same chat; both itineraries are preserved
- **Dark/light theme** — toggle in the sidebar; persisted across sessions
- **Mobile-friendly** — bottom nav, responsive layout

## Architecture

```
User (Voice/Text/Image)
      │
      ▼
  STT (Whisper)          ◄──── /transcribe
  Image upload           ◄──── /upload-image
      │
      ▼
  Agent (Gemini + ReAct loop)
      │  iterates up to 15 times
      ├─── search_places        → Tavily API (+ images)
      ├─── get_weather          → Open-Meteo (free)
      ├─── get_batch_directions → OSRM + Nominatim (free)
      ├─── save_user_preferences → user_preferences.json
      └─── save_memory          → user_memories.json
      │
      ▼
  Renderer (JSON normaliser)
      │
      ▼
  TTS (edge-tts)
      │
      ▼
  FastAPI → Browser
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| LLM | Gemini 3.1 Flash Lite Preview (`gemini-3.1-flash-lite-preview`) |
| STT | OpenAI Whisper (base, local) |
| TTS | edge-tts (free, no API key) |
| Places search | Tavily API (`include_images=True`) |
| Weather | Open-Meteo (free, no API key) |
| Routing | OSRM via routing.openstreetmap.de (free) |
| Geocoding | Nominatim / OpenStreetMap (free) |
| Backend | FastAPI + Uvicorn |
| Frontend | Vanilla HTML / CSS / JS (MediaRecorder for voice) |

## Project Structure

```
travel-agent/
├── agent.py              # Gemini ReAct loop, tool dispatch, multimodal input, JSON parsing
├── app.py                # FastAPI — /chat, /transcribe, /upload-image, /memories, /session
├── config.py             # env var loading (GEMINI_API_KEY, TAVILY_API_KEY)
├── renderer.py           # JSON normaliser — adds image_url, safe defaults
├── stt.py                # Whisper wrapper (lazy-loaded)
├── tts.py                # edge-tts async synthesizer
├── user_memory.py        # Structured preferences + freeform memory (save/load/delete)
├── tools/
│   ├── __init__.py       # TOOL_REGISTRY
│   ├── places.py         # search_places() — Tavily (with image_url per result)
│   ├── weather.py        # get_weather() — Open-Meteo
│   └── routes.py         # get_directions(), get_batch_directions() — OSRM
├── static/
│   ├── index.html        # Single-page UI (sidebar, chat, itinerary panels)
│   ├── style.css         # Dark/light theme, timeline, memory panel, image styles
│   ├── app.js            # Voice recording, image upload/paste, memory panel, fetch
│   ├── audio/            # TTS output (auto-cleaned, gitignored)
│   └── uploads/          # Temporary image uploads (auto-cleaned, gitignored)
├── requirements.txt
└── tests/
```

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Create `.env`

```env
GOOGLE_API_KEY=your_gemini_api_key_here
TAVILY_API_KEY=your_tavily_api_key_here
```

- **Gemini key**: [Google AI Studio](https://aistudio.google.com/) — use the free Flash Lite tier
- **Tavily key**: [Tavily](https://tavily.com/) — free tier, 1000 requests/month

Weather (Open-Meteo) and routing (OSRM) require no API keys.

### 3. Run

```bash
python app.py
```

Open [http://localhost:8000](http://localhost:8000).

## Testing Individual Modules

```bash
python tools/places.py          # Tavily place search (with images)
python tools/weather.py         # Open-Meteo forecast
python tools/routes.py          # OSRM directions
python stt.py test_audio.wav    # Whisper transcription
python tts.py "Hello world"     # edge-tts synthesis
python agent.py                 # Full agent with text input
```

## How It Works

1. **Input** — user types, records voice, or uploads/pastes an image
2. **STT** — Whisper transcribes audio to text (runs in a thread, non-blocking)
3. **Image** — if an image is attached, Gemini vision identifies the landmark; the agent searches and plans around it
4. **Agent loop** — Gemini receives the message and iteratively:
   - Calls `search_places` 2–3 times for different categories (attractions, restaurants, etc.)
   - Calls `get_weather` for the travel dates
   - Calls `get_batch_directions` once with all route legs
   - Calls `save_memory` when the user reveals personal preferences
   - Optionally calls `save_user_preferences` for structured pace/interest data
5. **Itinerary** — agent emits structured JSON; each activity includes an `image_url` from Tavily
6. **Rendering** — the renderer normalises the JSON; the frontend renders an HTML timeline with hero photos
7. **TTS** — edge-tts narrates a human-friendly summary
8. **Response** — browser receives text, structured data, and an audio URL simultaneously

## Memory System

The agent learns about the user naturally during conversation — no forms to fill in. When the user reveals something relevant ("I'm vegetarian", "traveling with two kids", "prefer boutique hotels"), the agent calls `save_memory` to store a short freeform note.

Memories are shown in the **Memory** section of the sidebar. Users can:
- View all saved memories
- Delete any memory with ×
- Manually add a memory via the text input

All memories are injected into the agent's system prompt context for every subsequent trip.

## Design Decisions

- **Tavily over Google Places** — no billing setup; `include_images=True` gives free photo URLs
- **OSRM over Google Directions** — completely free, sufficient accuracy for city-level routing
- **Batch directions** — one `get_batch_directions` call replaces N individual calls, staying within the 15-iteration agent budget
- **Freeform memory over rigid preferences** — preferences like "loves spicy food" or "hates crowds" are impossible to express in a dropdown; freeform text is more expressive and personalised
- **Whisper base** — fast enough for demo use; larger models trade speed for accuracy
- **Vanilla JS** — full control over UI without a framework; MediaRecorder gives direct mic access
- **edge-tts** — zero config, many voices, async, and free

## Limitations

- Whisper `base` model may struggle with heavy accents or background noise
- Tavily image URLs are third-party and may occasionally be broken (gracefully hidden via `onerror`)
- OSRM routing covers most of the world but may have gaps in rural areas
- The Gemini Flash Lite free tier is capped at 500 requests/day
- Image identification accuracy depends on Gemini vision — very obscure locations may not be recognised
