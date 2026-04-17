<p align="center">
  <img src="assets/cover.png" alt="ItineraTrace — Agentic Travel Planner" width="100%">
</p>

<p align="center">
  <strong>Trace the Thinking. Shape the Journey.</strong><br>
  A multimodal AI travel planning agent with voice, vision, and memory.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.13+-blue?logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/LLM-Gemini%20Flash-4285F4?logo=google&logoColor=white" alt="Gemini">
  <img src="https://img.shields.io/badge/STT-Whisper-74aa9c?logo=openai&logoColor=white" alt="Whisper">
  <img src="https://img.shields.io/badge/TTS-Edge--TTS-0078D4?logo=microsoft&logoColor=white" alt="Edge-TTS">
  <img src="https://img.shields.io/badge/framework-FastAPI-009688?logo=fastapi&logoColor=white" alt="FastAPI">
</p>

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="assets/screenshots/full-ui.png" alt="Full UI" width="60%"><br>
      <strong>Plan at a Glance</strong><br>
      <sub>Chat on the left, a rich visual itinerary on the right — every place backed by real search data and live photos.</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/screenshots/agent-thinking.png" alt="Agent Thinking" width="60%"><br>
      <strong>Watch It Think</strong><br>
      <sub>Live tool-call progress shows exactly which APIs the agent is querying — full transparency, zero hallucination.</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="assets/screenshots/voice.png" alt="Voice Input" width="50%"><br>
      <strong>Just Talk</strong><br>
      <sub>Tap the mic, describe your dream trip, and let Whisper handle the rest. The agent replies with both text and natural speech.</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/screenshots/vision.png" alt="Image Recognition" width="60%"><br>
      <strong>Snap a Landmark</strong><br>
      <sub>Paste or upload a photo — Gemini Vision identifies the spot and builds an itinerary around it, no typing needed.</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="assets/screenshots/interacts.png" alt="Interactive Cards" width="60%"><br>
      <strong>No Clicks, Your Picks</strong><br>
      <sub>Interactive tabs let you tap to select, input, or confirm stops — no more clicks on your keyboard.</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/screenshots/memory.png" alt="Memory Panel" width="60%"><br>
      <strong>It Remembers You</strong><br>
      <sub>Travel agents remember anything about you - You're a vegetarian or want more shoping and just feel free to say!</sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="assets/screenshots/dark-light.png" alt="Dark and Light Theme" width="50%"><br>
      <strong>Your Vibe, Your Theme</strong><br>
      <sub>Toggle between dark and light mode — your preference is remembered automatically.</sub>
    </td>
  </tr>
</table>

---
---

## Overview

**ItineraTrace** is a conversational travel planning agent that accepts **text, voice, and image** input and produces structured multi-day itineraries through grounded tool calls. It is built around a [ReAct](https://arxiv.org/abs/2210.03629) reasoning loop over Gemini Flash, with three external read-only tools (place search, weather, routing), a TTL-keyed in-memory cache, and a four-layer pipeline that keeps the browser, agent, tools, and renderer cleanly separated.

The system is built entirely on free-tier and open-source components: Gemini Flash for reasoning, [Whisper](https://arxiv.org/abs/2212.04356) (`base` multilingual) for ASR, Edge-TTS for speech synthesis, Tavily for place search, Open-Meteo for weather, and OSRM for driving routes.

Built as a solo final project for **CSCI3280 — Introduction to Multimedia, CUHK**.

---

## Features

### Multimodal Input & Output

| Input | Output |
|-------|--------|
| Text chat | Structured itinerary with photos |
| Voice recording (Whisper ASR) | Text-to-speech narration (Edge-TTS) |
| Image upload / paste (landmark recognition) | Real-time progress streaming (SSE) |

> Audio is transcribed to text at the input boundary and then follows the identical text path. Images are **not** reduced to text — raw bytes are passed as `Part.from_bytes` alongside the user's prompt, preserving visual context (architectural style, scene layout) that a caption would lose.

### Agentic Planning (ReAct Loop)

- Gemini Flash reasons step-by-step, calling tools iteratively (up to **15 iterations**, 30-second per-call timeout, linear backoff retries)
- **Zero hallucination** — every recommended location must come from a `search_places` result in the current conversation; the model is explicitly forbidden from fabricating names, addresses, or coordinates
- **Parallel tool dispatch** — multiple `function_call` blocks in a single iteration are dispatched concurrently via `ThreadPoolExecutor`, bounded by the slowest call rather than the sum
- **Weather-aware** — Open-Meteo 16-day forecasts injected into itinerary context
- **TTL cache with NFKC key normalisation** — deduplicates API calls within a session (6 hr TTL for places, 30 min for weather); only successful responses are cached to prevent stale error poisoning
- Structured JSON itinerary with times, durations, transport modes, and photos

### Dynamic Memory

- Two persistent stores: structured **preferences** (travel pace, dietary restrictions, meal times) via `save_user_preferences`; free-form **memories** inferred from conversation ("travelling with a toddler") via `save_memory`
- Both stores are injected verbatim into the system prompt at the start of every agent run — persistent personalisation without a retrieval step
- View, add, and delete memories from the sidebar panel

### Image Recognition

- Upload or paste a photo of any landmark
- Gemini Vision identifies the location and plans a trip around it
- Supports JPEG, PNG, GIF, and WebP

### Multi-Trip Management

- Create and switch between multiple trips in a single session
- Each trip preserves its own chat history and itinerary
- Multiple itineraries per trip (ask for a second destination mid-chat)

### Polished UI

- Dark / light theme toggle
- Smart suggestion chips that adapt to conversation context
- Responsive layout with mobile bottom navigation
- Floating stop button for TTS playback


## Architecture

<p align="center">
  <img src="assets/architecture.png" alt="System Architecture" width="100%">
</p>

The system is organised as **four cleanly separated layers**, communicating through JSON only with no shared mutable state — any one module can be replaced or tested in isolation.

### Layer 1 — Interface Layer

The browser submits input through three endpoints — `POST /chat`, `POST /transcribe`, `POST /upload-image` — which converge to a single message before reaching the agent. Audio is transcribed by Whisper (`base` multilingual, auto-detect) running inside `asyncio.to_thread`; images bypass text conversion entirely and are passed as raw bytes to preserve visual context.

### Layer 2 — Brain Layer (ReAct Agent Core)

`agent.py` runs a ReAct loop over Gemini Flash with a 15-iteration cap, a 30-second per-call timeout, and linear backoff retries on transient errors (2 s, 4 s, 6 s). Each iteration builds the system prompt by injecting the current date, stored user preferences, and free-form memories, then calls Gemini with the full conversation history. When Gemini emits `function_call` blocks, **all calls in that iteration are dispatched concurrently** via `ThreadPoolExecutor`; plain-text responses terminate the loop.

### Layer 3 — Tools Layer

| Tool | Type | External API | Cached? |
|------|------|-------------|---------|
| `search_places` | Read | Tavily | ✅ 6 hr TTL |
| `get_weather` | Read | Open-Meteo | ✅ 30 min TTL |
| `get_directions` | Read | OSRM | ✅ |
| `save_user_preferences` | Write | — (local JSON) | ❌ |
| `save_memory` | Write | — (local JSON) | ❌ |

The TTL cache keys every string argument through `unicodedata.normalize("NFKC", v.strip().lower())` before JSON-serialising with `sort_keys=True` and hashing to MD5. This prevents full-width / half-width CJK representations of the same destination from generating distinct cache keys. Only successful responses (no `"error"` key) are stored — transient API failures are never served as stale hits.

### Layer 4 — Output Layer

`renderer.py` traverses the agent's JSON response and fills any missing `transport_to_next`, `weather`, or `duration_minutes` fields with typed defaults so the frontend card renderer never encounters an unexpected null. All HTTP image URLs are rewritten through `/imgproxy`, which fetches and locally caches each image under an MD5-keyed filename — the browser only ever loads images through this local proxy. A client-side **two-phase TSP route optimiser** (nearest-neighbour + 2-opt local search, Haversine distances) runs entirely in the browser, eliminating the server round-trip and allowing instant re-optimisation when the user drags an itinerary item.

---

## Measured Behaviour: Cache Hit Rate

A benchmark was run issuing the same Kyoto query twice back-to-back (Run 1 cold cache → Run 2 warm cache):

| Tool | Run 1 (cold) | Run 2 (warm) |
|------|-------------|-------------|
| `get_weather` (1 call each run) | 2.75 s | 0.00 s (**HIT**) |
| `search_places` (4 cold / 5 warm calls) | 18.49 s | 24.91 s (all **MISS**) |

`get_weather` hit cleanly because its arguments (`location`, `start_date`, `end_date`) are structured and stable — identical across runs. `search_places` missed on every Run 2 call because Gemini generated a different natural-language query string each time ("historic temples and shrines in Kyoto" → "top temples and historical sites"), producing a different MD5 key for the same information need.

**The cache mechanism works as designed** — the `get_weather` hit proves this. The bottleneck is LLM query-string nondeterminism, not the cache implementation. Two directions follow: constrain Gemini to use a fixed query template per information need, or adopt **semantic caching** (embed the query, look up by cosine similarity above a threshold). The latter is listed as future work.

---

## Tech Stack

| Component | Technology | Cost |
|-----------|-----------|------|
| **LLM** | Gemini Flash (`gemini-flash`) | Free tier |
| **STT** | OpenAI Whisper (`base`, local) | Free |
| **TTS** | Edge-TTS | Free |
| **Places** | Tavily API (`include_images=True`) | Free tier (1k req/mo) |
| **Weather** | Open-Meteo | Free |
| **Routing** | OSRM | Free |
| **Backend** | FastAPI + Uvicorn (single worker) | — |
| **Frontend** | Vanilla HTML / CSS / JS | — |
| **Caching** | In-memory TTL cache (per-tool, NFKC-normalised MD5 keys) | — |

---

## Key Design Choices

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Input normalisation** | Audio → text at boundary; images passed as raw bytes | Transcripts preserve full utterance information; images carry visual context a caption would lose |
| **Parallel tool dispatch** | `ThreadPoolExecutor` per iteration batch | Bounds iteration latency to slowest call, not sum of calls |
| **Cache key normalisation** | NFKC + strip + lower + MD5 | Prevents full-width / half-width CJK variants from creating duplicate cache entries |
| **Differentiated TTL** | 6 hr places, 30 min weather | Aligns with data change cadence: POI data is slow-changing; weather forecasts update hourly |
| **Anti-hallucination** | Prompt contract + source-level image filtering (`_is_bad_image_url`) | Wrong address is worse than no address; favicon and stock-photo URLs are dropped before reaching the agent |
| **Image proxy** | All URLs rewritten through `/imgproxy` with MD5 disk cache | Browser never loads from untrusted third-party origins; repeated image loads are free |
| **Client-side TSP** | Nearest-neighbour + 2-opt in `app.js` | Eliminates server round-trip; re-optimises instantly on drag |
| **Memory architecture** | Two flat JSON stores (structured prefs + free-form memories) | Injected verbatim into system prompt; no retrieval step needed at project scale |
| **Whisper pre-warming** | Loaded asynchronously in FastAPI `lifespan` | Shifts 2–4 s model load off the first user interaction |
| **Places search** | Tavily (not Google Places) | Free image URLs via `include_images=True`; generous free tier |
| **Weather** | Open-Meteo (not OpenWeatherMap) | Free, no API key required, 16-day forecast |
| **TTS** | Edge-TTS (not Google/AWS TTS) | Zero-config, free, many natural voices, async-friendly |

---

## Getting Started

### Prerequisites

- Python 3.10+
- A [Gemini API key](https://aistudio.google.com/) (free tier)
- A [Tavily API key](https://tavily.com/) (free tier)

### Install

```bash
pip install -r requirements.txt
```

### Configure

Create a `.env` file in the project root:

```env
GOOGLE_API_KEY=your_gemini_key
TAVILY_API_KEY=your_tavily_key
```

Open-Meteo and OSRM require no API keys.

### Run

```bash
python app.py
# or with hot-reload
python app.py --dev
```

Open **http://localhost:8000**.

> Whisper `base` (~74 MB) is pre-warmed asynchronously on startup; the first `/transcribe` call will not incur the model load penalty.

---

## Project Structure

```
travel-agent/
├── agent.py            # ReAct loop, system prompt, parallel tool dispatch, multimodal input
├── app.py              # FastAPI endpoints, SSE streaming, session management, boot-marker
├── config.py           # Environment variable loading
├── renderer.py         # JSON normaliser (typed defaults, /imgproxy URL rewriting)
├── stt.py              # Whisper STT wrapper (pre-warmed via lifespan)
├── tts.py              # Edge-TTS async synthesis
├── user_memory.py      # Memory persistence (structured prefs + free-form memories)
├── tools/
│   ├── __init__.py     # TOOL_REGISTRY + TTL cache (NFKC MD5 keying)
│   ├── places.py       # Tavily search + _is_bad_image_url filter
│   ├── weather.py      # Open-Meteo 16-day forecast
│   └── routes.py       # OSRM routing + Nominatim geocoding
├── static/
│   ├── index.html      # Single-page UI (sidebar + chat + itinerary)
│   ├── style.css       # Dark/light theme, timeline, responsive layout
│   ├── app.js          # Voice, image upload, memory panel, TSP optimiser, rendering
│   ├── audio/          # TTS output (auto-cleaned)
│   ├── uploads/        # Temp image uploads (auto-cleaned)
│   └── imgcache/       # /imgproxy disk cache (MD5-keyed)
├── assets/
│   ├── cover.png
│   ├── architecture.png
│   └── screenshots/
└── requirements.txt
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/chat` | Main agent chat (SSE streaming) |
| `POST` | `/transcribe` | Audio → text via Whisper |
| `POST` | `/upload-image` | Upload image for vision-grounded planning |
| `GET` | `/imgproxy` | Fetch and cache external image through local proxy |
| `GET` | `/memories` | List all saved memories |
| `POST` | `/memories` | Add a memory manually |
| `DELETE` | `/memories/{id}` | Delete a memory |
| `DELETE` | `/session/{id}` | Clear conversation history |

---

## How It Works

1. **Input** — user types, speaks, or uploads an image
2. **STT** — Whisper transcribes audio in a background thread (`asyncio.to_thread`); images bypass transcription and are passed as raw bytes
3. **Agent loop** — Gemini Flash iterates through tool calls (up to 15 iterations):
   - `search_places` — real attractions, restaurants, cafes via Tavily
   - `get_weather` — Open-Meteo 16-day forecast for travel dates
   - `get_directions` — driving duration via OSRM; transit estimated as 1.8× driving
   - `save_user_preferences` / `save_memory` — persist user state to disk
   - Multiple calls per iteration dispatched concurrently; cached responses returned in ~0 ms
4. **Rendering** — `renderer.py` normalises JSON with typed defaults; `/imgproxy` rewrites all image URLs through local disk cache
5. **TSP** — client-side nearest-neighbour + 2-opt optimiser reorders stops for a shorter route
6. **TTS** — Edge-TTS narrates a human-friendly summary
7. **Response** — browser receives text, itinerary data, and audio via SSE

---

## Limitations & Future Work

- **Semantic caching** — the current MD5 exact-match cache cannot detect that "historic temples and shrines in Kyoto" and "top temples and historical sites" express the same information need. Moving to embedding-based cosine-similarity lookup above a threshold is the highest-priority improvement.
- **Single-worker, in-memory state** — session store, TTL cache, preferences, and memories all live inside a single Uvicorn worker. Horizontal scaling would require externalising at least the session store and cache (e.g., Redis).
- **Transit routing is a coarse heuristic** — public-transit time is estimated as 1.8× OSRM driving duration. Integrating a GTFS-based service (e.g., OpenTripPlanner) would give proper durations.
- Whisper `base` may struggle with heavy accents or noisy environments.
- Gemini Flash free tier: limited daily request quota.

---

## License

Academic project — CSCI3280 Introduction to Multimedia, CUHK.