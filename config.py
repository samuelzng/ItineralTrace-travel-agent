import os
from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY = os.getenv("GOOGLE_API_KEY")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")

# Free APIs
OPENMETEO_BASE_URL = "https://api.open-meteo.com/v1"
GEOCODING_BASE_URL = "https://geocoding-api.open-meteo.com/v1"

assert GEMINI_API_KEY, "GOOGLE_API_KEY not found in .env"
assert TAVILY_API_KEY, "TAVILY_API_KEY not found in .env"
