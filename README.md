# AI Travel Agent

A multimodal AI travel planning agent built for CSCI3280 (Introduction to Multimedia). Accepts voice and text input, calls live APIs to find real places, and returns a structured itinerary with text-to-speech narration.

## Features

- **Voice + Text I/O** — speak or type your request; responses are played back via TTS
- **ReAct agent loop** — Gemini LLM reasons step-by-step and calls tools until the itinerary is complete
- **Zero hallucination** — every recommended place comes from a live Tavily web search
- **Weather-aware** — checks the 16-day forecast and adapts activity suggestions accordingly
- **Realistic routing** — computes walking/transit distances between all stops in one batch call
- **User memory** — saves your pace and interest preferences across sessions
- **Dark-theme web UI** — sidebar, chat panel, visual itinerary timeline, mobile bottom nav

## Architecture

```
User (Voice/Text)
      │
      ▼
  STT (Whisper)          ◄──── /transcribe endpoint
      │
      ▼
  Agent (Gemini + ReAct loop)
      │  iterates up to 15 times
      ├─── search_places   → Tavily API
      ├─── get_weather     → Open-Meteo (free)
      ├─── get_batch_directions → OSRM + Nominatim (free)
      └─── save_user_preferences → user_preferences.json
      │
      ▼
  Renderer (JSON → HTML timeline)
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
| Places search | Tavily API |
| Weather | Open-Meteo (free, no API key) |
| Routing | OSRM via routing.openstreetmap.de (free) |
| Geocoding | Nominatim / OpenStreetMap (free) |
| Backend | FastAPI + Uvicorn |
| Frontend | Vanilla HTML / CSS / JS (MediaRecorder for voice) |

## Project Structure

```
travel-agent/
├── agent.py              # Gemini ReAct loop, tool dispatch, JSON parsing
├── app.py                # FastAPI — /chat, /transcribe, /preferences, /session
├── config.py             # env var loading (GEMINI_API_KEY, TAVILY_API_KEY)
├── renderer.py           # Structured JSON → HTML itinerary timeline
├── stt.py                # Whisper wrapper (lazy-loaded)
├── tts.py                # edge-tts async synthesizer
├── user_memory.py        # Load/save user_preferences.json
├── tools/
│   ├── __init__.py       # TOOL_REGISTRY
│   ├── places.py         # search_places() — Tavily
│   ├── weather.py        # get_weather() — Open-Meteo
│   └── routes.py         # get_directions(), get_batch_directions() — OSRM
├── static/
│   ├── index.html        # Single-page UI
│   ├── style.css         # Dark theme, timeline, mobile nav
│   ├── app.js            # Voice recording, fetch, panel switching
│   └── audio/            # TTS output (auto-cleaned, gitignored)
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
python tools/places.py          # Tavily place search
python tools/weather.py         # Open-Meteo forecast
python tools/routes.py          # OSRM directions
python stt.py test_audio.wav    # Whisper transcription
python tts.py "Hello world"     # edge-tts synthesis
python agent.py                 # Full agent with text input
```

## How It Works

1. **Input** — user types or records a voice message
2. **STT** — Whisper transcribes audio to text (runs in a thread, non-blocking)
3. **Agent loop** — Gemini receives the message and iteratively:
   - Calls `search_places` 2–3 times for different categories (attractions, restaurants, etc.)
   - Calls `get_weather` for the travel dates
   - Calls `get_batch_directions` once with all route legs
   - Optionally calls `save_user_preferences` for new users
4. **Itinerary** — agent emits a structured JSON response; the renderer converts it to an HTML timeline
5. **TTS** — edge-tts narrates a human-friendly summary of the itinerary
6. **Response** — the browser receives text, HTML, and an audio URL simultaneously

## Design Decisions

- **Tavily over Google Places** — no billing setup needed for development; returns rich web content
- **OSRM over Google Directions** — completely free, sufficient accuracy for city-level routing
- **Batch directions** — one `get_batch_directions` call replaces N individual calls, staying within the 10-iteration agent budget
- **Whisper base** — fast enough for demo use; larger models trade speed for accuracy
- **Vanilla JS** — full control over UI without a framework; MediaRecorder gives direct mic access
- **edge-tts** — zero config, many voices, async, and free

## Limitations

- Whisper `base` model may struggle with heavy accents or background noise
- Tavily search quality depends on destination popularity; very obscure locations may return sparse results
- OSRM routing covers most of the world but may have gaps in rural areas
- The Gemini Flash Lite free tier is capped at 500 requests/day
