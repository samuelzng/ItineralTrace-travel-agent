/* ── Constants ──────────────────────────────────────────────────────────────── */
const DEFAULT_SUBTITLE = 'No itinerary yet — ask me to plan a trip!';

const TRANSPORT_ICONS = {
  walk: '🚶', drive: '🚗', bike: '🚲',
  subway: '🚇', metro: '🚇', bus: '🚌',
  taxi: '🚕', transit: '🚌',
};

/* ── State ──────────────────────────────────────────────────────────────────── */
// trip = { id, name, messages: [{role, content}], itinerary: null|{...} }
let trips = [];
let activeTripIdx = -1;
let isProcessing = false;
let chatAbortController = null;
let mediaRecorder = null;
let audioChunks = [];
let _sendGeneration = 0;

/* ── DOM refs ──────────────────────────────────────────────────────────────── */
const messagesEl        = document.getElementById('messages');
const inputText         = document.getElementById('input-text');
const btnSend           = document.getElementById('btn-send');
const btnMic            = document.getElementById('btn-mic');
const btnStopRec        = document.getElementById('btn-stop-rec');
const ttsAudio          = document.getElementById('tts-audio');
const recOverlay        = document.getElementById('recording-overlay');
const itineraryEl       = document.getElementById('itinerary-container');
const itineraryBadge    = document.getElementById('itinerary-badge');
const itinerarySubtitle = document.getElementById('itinerary-subtitle');
const navItems          = document.querySelectorAll('.nav-item');
const mobileNavItems    = document.querySelectorAll('.mobile-nav-item[data-panel]');
const mobileBadge       = document.getElementById('mobile-itinerary-badge');
const mobileNewBtn      = document.getElementById('mobile-btn-new');
const panels            = { chat: document.getElementById('panel-chat'), itinerary: document.getElementById('panel-itinerary') };
const btnNewTrip        = document.getElementById('btn-new-trip');
const btnDeleteTrip     = document.getElementById('btn-delete-trip');
const tripListEl        = document.getElementById('trip-list');

/* ══════════════════════════════════════════════════════════════════════════════
   RENDERING — all HTML is generated here from structured data
   ══════════════════════════════════════════════════════════════════════════════ */

/* ── Message rendering ─────────────────────────────────────────────────────── */
function renderAllMessages() {
  messagesEl.innerHTML = '';
  const trip = getActiveTrip();
  if (!trip) return;
  const msgs = trip.messages;
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const isLast = (i === msgs.length - 1);
    if (msg.role === 'user') {
      messagesEl.appendChild(buildUserBubble(msg.content));
    } else {
      messagesEl.appendChild(buildAgentBubble(msg.content, isLast));
    }
  }
  scrollToBottom();
}

function buildUserBubble(text) {
  const div = document.createElement('div');
  div.className = 'message message--user';
  div.innerHTML = `
    <div class="message__avatar">👤</div>
    <div class="message__bubble"><p>${esc(text)}</p></div>`;
  return div;
}

/* ── Inline chip definitions ──────────────────────────────────────────────── */

const WELCOME_CHIPS = [
  "Plan a 2-day trip to Tokyo",
  "What's the weather in Paris this weekend?",
  "Find attractions in Bangkok",
  "Change my preferences",
];

const INTEREST_CHIPS = [
  "History & culture",
  "Food & local cuisine",
  "Nature & outdoors",
  "Shopping",
  "A good mix of everything",
];

const PACE_CHIPS = [
  "Relaxed — plenty of downtime",
  "Moderate pace",
  "Packed — as much as possible",
];

const MEAL_CHIPS = [
  "Noon and 6pm works",
  "I prefer late meals, 1pm and 7pm",
];

const PREFS_CONFIRM_CHIPS = [
  "Sounds good, go ahead",
  "Change my preferences",
];

/**
 * Extract the plain text from any message content format,
 * so chip detection always works regardless of format.
 */
function _textOf(content) {
  if (typeof content === 'string') return content;
  if (typeof content === 'object') return content.data || '';
  return '';
}

/**
 * Determine which chips to show for a given agent message.
 * Returns an array of chip labels, or null for no chips.
 *
 * Detection is ORDER-SENSITIVE: pace is asked first, then interests.
 * We check for the most specific patterns to avoid cross-matching.
 */
function detectChips(content) {
  // Never show chips on itineraries
  if (typeof content === 'object' && content.type === 'itinerary') return null;

  // Welcome message — always show starter chips
  if (typeof content === 'object' && content.type === 'welcome') return WELCOME_CHIPS;

  const lower = _textOf(content).toLowerCase();
  if (!lower) return null;

  // Legacy welcome message (plain string from old localStorage)
  if (/travel assistant/.test(lower) && /trip|plan/.test(lower) && lower.length < 400) return WELCOME_CHIPS;

  // Agent mentions saved preferences
  if (/saved preferences|your preferences/.test(lower)) return PREFS_CONFIRM_CHIPS;

  // Step 1: Agent asking for destination & days
  if (/where.*go|where.*like|how many days|destination/.test(lower) && !/pace|relaxed|interest|cuisine/.test(lower)) return '__DESTINATION_FORM__';

  // Step 2: Agent asking about PACE
  if (/pace|relaxed.*packed|packed.*relaxed/.test(lower) && !/interest|cuisine|nature|shopping/.test(lower)) return PACE_CHIPS;

  // Step 3: Agent asking about INTERESTS
  if (/interest|cuisine|food.*nature|history.*culture|what.*into/.test(lower) && !/pace|relaxed.*packed/.test(lower)) return INTEREST_CHIPS;

  // Agent asking about meal times
  if (/lunch.*dinner|meal\s*time/.test(lower)) return MEAL_CHIPS;

  return null;
}

function _buildChipsOrForm(detected) {
  if (!detected) return '';
  if (detected === '__DESTINATION_FORM__') {
    return `
      <div class="inline-form">
        <div class="inline-form-row">
          <label>Destination</label>
          <input type="text" class="inline-input" id="inline-dest" placeholder="e.g. Hong Kong, Tokyo, Paris" />
        </div>
        <div class="inline-form-row">
          <label>How many days?</label>
          <div class="inline-days-row">
            <button class="chip chip--day" data-days="1">1</button>
            <button class="chip chip--day" data-days="2">2</button>
            <button class="chip chip--day" data-days="3">3</button>
            <input type="number" class="inline-input inline-days-input" id="inline-days" min="1" max="30" placeholder="other" />
          </div>
        </div>
        <button class="btn-inline-submit" id="inline-submit" disabled>Let's go</button>
      </div>`;
  }
  return `<div class="inline-chips">${
    detected.map(s => `<button class="chip">${esc(s)}</button>`).join('')
  }</div>`;
}

function buildAgentBubble(content, isLast) {
  const div = document.createElement('div');
  div.className = 'message message--agent';

  let bubbleHtml;

  if (typeof content === 'object' && content.type === 'itinerary') {
    const d = content.data;
    const nDays = (d.days || []).length;
    const dest = esc(d.destination || 'your destination');
    const dates = d.dates ? `${d.dates.start} → ${d.dates.end}` : '';
    bubbleHtml = `
      <p>Your <strong>${nDays}-day itinerary for ${dest}</strong> is ready!</p>
      ${dates ? `<p style="color:var(--text-3);font-size:13px">${esc(dates)}</p>` : ''}
      <p style="margin-top:10px"><button class="btn-view-itinerary" onclick="switchPanel('itinerary')">View Itinerary →</button></p>`;
  } else {
    const text = _textOf(content);
    bubbleHtml = esc(text).split('\n').filter(Boolean).map(line =>
      `<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`
    ).join('');
  }

  // Only show interactive elements on the LAST agent message
  let interactiveHtml = '';
  if (isLast) {
    interactiveHtml = _buildChipsOrForm(detectChips(content));
  }

  div.innerHTML = `
    <div class="message__avatar">✈</div>
    <div class="message__bubble">${bubbleHtml}${interactiveHtml}</div>`;

  // Wire up chip clicks
  div.querySelectorAll('.chip:not(.chip--day)').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.inline-chips').forEach(el => el.remove());
      sendMessage(btn.textContent);
    });
  });

  // Wire up destination form
  const inlineForm = div.querySelector('.inline-form');
  if (inlineForm) {
    const destInput = inlineForm.querySelector('#inline-dest');
    const daysInput = inlineForm.querySelector('#inline-days');
    const submitBtn = inlineForm.querySelector('#inline-submit');

    function getDays() {
      // Prefer the typed number; fall back to selected chip
      const typed = parseInt(daysInput.value);
      if (typed > 0) return typed;
      const sel = inlineForm.querySelector('.chip--day.chip--selected');
      return sel ? parseInt(sel.dataset.days) : 0;
    }

    function validate() {
      submitBtn.disabled = !destInput.value.trim() || !getDays();
    }

    // Day chip selection — also sync into the number input
    inlineForm.querySelectorAll('.chip--day').forEach(btn => {
      btn.addEventListener('click', () => {
        inlineForm.querySelectorAll('.chip--day').forEach(b => b.classList.remove('chip--selected'));
        btn.classList.add('chip--selected');
        daysInput.value = btn.dataset.days;
        validate();
      });
    });

    // Typing in the number input clears chip selection
    daysInput.addEventListener('input', () => {
      inlineForm.querySelectorAll('.chip--day').forEach(b => b.classList.remove('chip--selected'));
      validate();
    });

    destInput.addEventListener('input', validate);

    // Submit
    submitBtn.addEventListener('click', () => {
      const dest = destInput.value.trim();
      const days = getDays();
      if (!dest || !days) return;
      inlineForm.remove();
      sendMessage(`${dest}, ${days} day${days > 1 ? 's' : ''}`);
    });

    // Enter in either input submits
    [destInput, daysInput].forEach(el => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !submitBtn.disabled) {
          e.preventDefault();
          submitBtn.click();
        }
      });
    });
  }

  return div;
}

/* ── Itinerary rendering ───────────────────────────────────────────────────── */
function renderItinerary() {
  const trip = getActiveTrip();
  const itin = trip?.itinerary;
  if (!itin) {
    itineraryEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗺</div>
        <p>Your itinerary will appear here once you ask me to plan a trip.</p>
      </div>`;
    itinerarySubtitle.textContent = DEFAULT_SUBTITLE;
    return;
  }

  const dateRange = itin.dates ? `${itin.dates.start} → ${itin.dates.end}` : '';
  itinerarySubtitle.textContent =
    (itin.destination || '') + (dateRange ? '  •  ' + dateRange : '');

  const daysHtml = (itin.days || []).map(renderDay).join('\n');

  itineraryEl.innerHTML = `
    <div class="itinerary">
      <div class="itinerary-header">
        <h2 class="destination">${esc(itin.destination || 'Unknown')}</h2>
        <span class="date-range">${esc(dateRange)}</span>
        <p class="weather-summary">${esc(itin.weather_summary || '')}</p>
      </div>
      <div class="days">${daysHtml}</div>
    </div>`;
}

function renderDay(day) {
  const w = day.weather || {};
  const condStr = `${esc(String(w.condition || ''))} · ${w.temp_high}°C / ${w.temp_low}°C`;
  const acts = (day.activities || []);
  const actsHtml = acts.map((a, i) => renderActivity(a, i === acts.length - 1)).join('\n');

  return `
    <div class="day-card">
      <div class="day-header">
        <span class="day-date">${esc(day.date || '')}</span>
        <span class="day-weather">${condStr}</span>
      </div>
      <div class="activities">${actsHtml}</div>
    </div>`;
}

function renderActivity(a, isLast) {
  const lineHtml = isLast ? '' : '<div class="activity-line"></div>';
  let transportHtml = '';
  if (a.transport_to_next) {
    const t = a.transport_to_next;
    const mode = (t.mode || '').toLowerCase();
    // Skip rendering if mode is "none" or empty, or distance is 0
    if (mode && mode !== 'none' && t.duration !== '0 min') {
      const icon = TRANSPORT_ICONS[mode] || '➡️';
      transportHtml = `
        <div class="transport">
          <span class="transport-icon">${icon}</span>
          ${esc(t.mode || '')} · ${esc(t.duration || '')} · ${esc(t.distance || '')}
        </div>`;
    }
  }

  return `
    <div class="activity">
      <div class="activity-main">
        <div class="activity-time">${esc(a.time || '')}</div>
        <div class="activity-dot-line">
          <div class="activity-dot"></div>
          ${lineHtml}
        </div>
        <div class="activity-body">
          <div class="activity-place">${esc(a.place || '')}</div>
          <div class="activity-address">${esc(a.address || '')}</div>
          <div class="activity-desc">${esc(a.description || '')}</div>
          <div class="activity-duration">${a.duration_minutes || 0} min</div>
        </div>
      </div>
      ${transportHtml}
    </div>`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   TRIP STATE MANAGEMENT — data is the source of truth
   ══════════════════════════════════════════════════════════════════════════════ */

function getActiveTrip() {
  return activeTripIdx >= 0 && activeTripIdx < trips.length ? trips[activeTripIdx] : null;
}

function getSessionId() {
  const trip = getActiveTrip();
  return trip ? trip.id : '';
}

function persistTrips() {
  try {
    localStorage.setItem('travelai_trips', JSON.stringify(trips));
  } catch (e) {
    console.warn('localStorage save failed', e);
    // Drop old message history to free space, keep itineraries
    for (const t of trips) {
      if (t.messages.length > 20) t.messages = t.messages.slice(-20);
    }
    try { localStorage.setItem('travelai_trips', JSON.stringify(trips)); } catch (_) {}
  }
}

function cancelInFlight() {
  _sendGeneration++;
  if (chatAbortController) { chatAbortController.abort(); chatAbortController = null; }
  stopTTS();
  document.querySelectorAll('.message--typing').forEach(el => el.remove());
  setProcessing(false);
}

/* ── Trip CRUD ─────────────────────────────────────────────────────────────── */
async function createTrip() {
  cancelInFlight();

  const id = uuid();

  // Fetch saved preferences to show in welcome message
  let welcomeText = "Hello! I'm your AI travel assistant. Tell me where you'd like to go, and I'll plan the perfect trip for you.\n\n**Tips**\n🌗 Toggle light/dark mode — button next to the logo (top-left)\n🔇 A stop button appears at the top-right when I'm speaking";
  try {
    const res = await fetch('/preferences');
    if (res.ok) {
      const prefs = await res.json();
      if (prefs.pace || (prefs.interests && prefs.interests.length)) {
        const parts = [];
        if (prefs.pace) parts.push(prefs.pace + ' pace');
        if (prefs.interests && prefs.interests.length) parts.push(prefs.interests.join(', '));
        welcomeText += `\n\nYour saved preferences: ${parts.join(' · ')}`;
      }
    }
  } catch (_) { /* offline or first run — no big deal */ }

  const trip = {
    id,
    name: 'New Trip',
    messages: [
      { role: 'agent', content: { type: "welcome", data: welcomeText } }
    ],
    itinerary: null,
  };
  trips.push(trip);
  activeTripIdx = trips.length - 1;

  persistTrips();
  renderAllMessages();
  renderItinerary();
  renderTripList();
  switchPanel('chat');
  inputText.focus();
}

function switchTrip(idx) {
  if (idx === activeTripIdx) return;
  cancelInFlight();
  activeTripIdx = idx;
  persistTrips();
  renderAllMessages();
  renderItinerary();
  renderTripList();
}

function deleteActiveTrip() {
  if (activeTripIdx < 0) return;
  cancelInFlight();

  const trip = trips[activeTripIdx];
  fetch(`/session/${trip.id}`, { method: 'DELETE' }).catch(() => {});
  trips.splice(activeTripIdx, 1);

  if (trips.length === 0) {
    activeTripIdx = -1;
    createTrip();
  } else {
    activeTripIdx = Math.min(activeTripIdx, trips.length - 1);
    persistTrips();
    renderAllMessages();
    renderItinerary();
    renderTripList();
  }
}

function deleteTripAt(idx) {
  if (idx === activeTripIdx) { deleteActiveTrip(); return; }
  const trip = trips[idx];
  fetch(`/session/${trip.id}`, { method: 'DELETE' }).catch(() => {});
  trips.splice(idx, 1);
  if (idx < activeTripIdx) activeTripIdx--;
  persistTrips();
  renderTripList();
}

function renderTripList() {
  tripListEl.innerHTML = trips.map((trip, i) => `
    <div class="trip-item ${i === activeTripIdx ? 'active' : ''}" data-idx="${i}">
      <span class="trip-item-icon">🗺</span>
      <span class="trip-item-name">${esc(trip.name)}</span>
      <button class="trip-item-delete" data-idx="${i}" title="Delete">&times;</button>
    </div>
  `).join('');

  tripListEl.querySelectorAll('.trip-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.trip-item-delete')) return;
      switchTrip(parseInt(el.dataset.idx));
    });
  });
  tripListEl.querySelectorAll('.trip-item-delete').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      deleteTripAt(parseInt(el.dataset.idx));
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
   CHAT — send message, handle response
   ══════════════════════════════════════════════════════════════════════════════ */

async function sendMessage(text) {
  const msg = (text || inputText.value).trim();
  if (!msg || isProcessing) return;

  inputText.value = '';
  inputText.style.height = 'auto';

  // Push user message to data model and render
  const trip = getActiveTrip();
  if (!trip) return;
  trip.messages.push({ role: 'user', content: msg });
  messagesEl.appendChild(buildUserBubble(msg));
  document.querySelectorAll('.inline-chips').forEach(el => el.remove());  // clear chips
  scrollToBottom();
  setProcessing(true);

  // Auto-name from first user message
  if (trip.name === 'New Trip') {
    trip.name = msg.length > 40 ? msg.slice(0, 37) + '...' : msg;
    persistTrips();
    renderTripList();
  }

  const gen = _sendGeneration;
  chatAbortController = new AbortController();
  const typingId = appendTyping();

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, session_id: getSessionId() }),
      signal: chatAbortController.signal,
    });
    if (gen !== _sendGeneration) return;
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    if (gen !== _sendGeneration) return;

    removeTyping(typingId);

    // data.response = {type: "text"|"itinerary", data: ...}
    const resp = data.response;
    trip.messages.push({ role: 'agent', content: resp });
    messagesEl.appendChild(buildAgentBubble(resp, true));  // last message → show chips
    scrollToBottom();

    if (resp.type === 'itinerary') {
      trip.itinerary = resp.data;
      trip.name = resp.data.destination || trip.name;
      renderItinerary();
      renderTripList();
      showItineraryBadge();
    }

    if (data.audio_url) playTTS(data.audio_url);
    persistTrips();
    loadPrefsUI();  // sync sidebar panel in case agent saved preferences

  } catch (err) {
    if (gen !== _sendGeneration) return;
    removeTyping(typingId);
    if (err.name === 'AbortError') return;
    const detail = navigator.onLine ? esc(err.message) : 'You appear to be offline.';
    // Push error as agent message
    const errText = `Something went wrong: ${detail}`;
    trip.messages.push({ role: 'agent', content: errText });
    messagesEl.appendChild(buildAgentBubble(errText));
    scrollToBottom();
  } finally {
    chatAbortController = null;
    if (gen === _sendGeneration) setProcessing(false);
  }
}

function showItineraryBadge() {
  const chatActive = document.querySelector('.nav-item[data-panel="chat"]')?.classList.contains('active')
    || document.querySelector('.mobile-nav-item[data-panel="chat"]')?.classList.contains('active');
  if (chatActive) {
    itineraryBadge.hidden = false;
    itineraryBadge.textContent = 'New';
    if (mobileBadge) { mobileBadge.hidden = false; mobileBadge.textContent = 'New'; }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   PANEL SWITCHING
   ══════════════════════════════════════════════════════════════════════════════ */

function switchPanel(target) {
  navItems.forEach(b => b.classList.remove('active'));
  document.querySelector(`.nav-item[data-panel="${target}"]`)?.classList.add('active');
  mobileNavItems.forEach(b => b.classList.remove('active'));
  document.querySelector(`.mobile-nav-item[data-panel="${target}"]`)?.classList.add('active');
  Object.entries(panels).forEach(([key, el]) => el.classList.toggle('panel--hidden', key !== target));
  if (target === 'itinerary') {
    itineraryBadge.hidden = true;
    if (mobileBadge) mobileBadge.hidden = true;
  }
}

navItems.forEach(btn => btn.addEventListener('click', () => switchPanel(btn.dataset.panel)));
mobileNavItems.forEach(btn => btn.addEventListener('click', () => switchPanel(btn.dataset.panel)));
if (mobileNewBtn) mobileNewBtn.addEventListener('click', () => createTrip());

/* ══════════════════════════════════════════════════════════════════════════════
   VOICE RECORDING
   ══════════════════════════════════════════════════════════════════════════════ */

btnMic.addEventListener('click', startRecording);
btnStopRec.addEventListener('click', stopRecording);

async function startRecording() {
  if (isProcessing) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = handleRecordingStop;
    mediaRecorder.start();
    btnMic.classList.add('recording');
    recOverlay.hidden = false;
  } catch (err) {
    const trip = getActiveTrip();
    if (trip) {
      trip.messages.push({ role: 'agent', content: 'Microphone access denied. Please allow microphone access.' });
      renderAllMessages();
    }
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  btnMic.classList.remove('recording');
  recOverlay.hidden = true;
}

async function handleRecordingStop() {
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  const formData = new FormData();
  formData.append('audio', blob, 'recording.webm');

  setProcessing(true);
  const typingId = appendTyping();

  try {
    const res = await fetch('/transcribe', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`Transcription failed ${res.status}`);
    const { text } = await res.json();
    removeTyping(typingId);
    setProcessing(false);
    if (text.trim()) { sendMessage(text.trim()); }
    else {
      const trip = getActiveTrip();
      if (trip) { trip.messages.push({ role: 'agent', content: "I couldn't hear anything. Please try again." }); renderAllMessages(); }
    }
  } catch (err) {
    removeTyping(typingId);
    setProcessing(false);
    const trip = getActiveTrip();
    if (trip) { trip.messages.push({ role: 'agent', content: `Transcription error: ${err.message}` }); renderAllMessages(); }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   TTS & UI HELPERS
   ══════════════════════════════════════════════════════════════════════════════ */

const btnStopTTS = document.getElementById('btn-stop-tts');

function playTTS(url) {
  ttsAudio.src = url;
  ttsAudio.play().catch(() => {});
  btnStopTTS.hidden = false;
}

function stopTTS() {
  ttsAudio.pause();
  ttsAudio.src = '';
  btnStopTTS.hidden = true;
}

ttsAudio.addEventListener('ended', () => { btnStopTTS.hidden = true; });
ttsAudio.addEventListener('pause', () => { btnStopTTS.hidden = true; });
btnStopTTS.addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  stopTTS();
});

let _typingCounter = 0;
function appendTyping() {
  const id = 'typing-' + (++_typingCounter);
  const div = document.createElement('div');
  div.className = 'message message--agent message--typing';
  div.id = id;
  div.innerHTML = `
    <div class="message__avatar">✈</div>
    <div class="message__bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
  return id;
}

function removeTyping(id) { document.getElementById(id)?.remove(); }
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function setProcessing(val) {
  isProcessing = val;
  btnSend.disabled = val;
  btnMic.disabled = val;
  inputText.disabled = val;
  btnSend.classList.toggle('loading', val);
  if (!val) inputText.focus();
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts (http://localhost)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/* ── Textarea auto-resize ──────────────────────────────────────────────────── */
inputText.addEventListener('input', () => {
  inputText.style.height = 'auto';
  inputText.style.height = Math.min(inputText.scrollHeight, 160) + 'px';
});
inputText.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
btnSend.addEventListener('click', sendMessage);
btnNewTrip.addEventListener('click', createTrip);
btnDeleteTrip.addEventListener('click', deleteActiveTrip);

/* ══════════════════════════════════════════════════════════════════════════════
   THEME TOGGLE
   ══════════════════════════════════════════════════════════════════════════════ */

const btnTheme    = document.getElementById('btn-theme');
const themeIcon   = document.getElementById('theme-icon');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('travelai_theme', theme);
  themeIcon.textContent = theme === 'light' ? '🌙' : '☀';
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// Restore saved theme
applyTheme(localStorage.getItem('travelai_theme') || 'dark');

/* ══════════════════════════════════════════════════════════════════════════════
   PREFERENCES PANEL
   ══════════════════════════════════════════════════════════════════════════════ */

const prefsToggle = document.getElementById('prefs-toggle');
const prefsPanel  = document.getElementById('prefs-panel');
const prefsArrow  = document.getElementById('prefs-arrow');
const prefPace    = document.getElementById('pref-pace');
const prefLunch   = document.getElementById('pref-lunch');
const prefDinner  = document.getElementById('pref-dinner');
const prefInterestChecks = document.querySelectorAll('#pref-interests input[type="checkbox"]');
const btnSavePrefs = document.getElementById('btn-save-prefs');

prefsToggle.addEventListener('click', () => {
  const isOpen = !prefsPanel.hidden;
  prefsPanel.hidden = isOpen;
  prefsArrow.classList.toggle('open', !isOpen);
});

async function loadPrefsUI() {
  try {
    const res = await fetch('/preferences');
    if (!res.ok) return;
    const prefs = await res.json();
    if (prefs.pace) prefPace.value = prefs.pace;
    if (prefs.lunch_time) prefLunch.value = prefs.lunch_time;
    if (prefs.dinner_time) prefDinner.value = prefs.dinner_time;
    if (Array.isArray(prefs.interests)) {
      prefInterestChecks.forEach(cb => {
        cb.checked = prefs.interests.includes(cb.value);
      });
    }
  } catch (_) {}
}

btnSavePrefs.addEventListener('click', async () => {
  const interests = [];
  prefInterestChecks.forEach(cb => { if (cb.checked) interests.push(cb.value); });

  const body = {
    pace: prefPace.value || undefined,
    interests: interests.length ? interests : undefined,
    lunch_time: prefLunch.value || undefined,
    dinner_time: prefDinner.value || undefined,
  };

  try {
    await fetch('/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    btnSavePrefs.textContent = 'Saved!';
    btnSavePrefs.classList.add('saved');
    setTimeout(() => {
      btnSavePrefs.textContent = 'Save';
      btnSavePrefs.classList.remove('saved');
    }, 1500);
  } catch (e) {
    btnSavePrefs.textContent = 'Error';
    setTimeout(() => { btnSavePrefs.textContent = 'Save'; }, 1500);
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
   INIT — migrate legacy data or create first trip
   ══════════════════════════════════════════════════════════════════════════════ */

(async function init() {
  loadPrefsUI();

  // Check if the server has restarted (fresh user) by comparing a boot token
  let serverBoot = '';
  try {
    const res = await fetch('/boot-id');
    if (res.ok) serverBoot = (await res.json()).id;
  } catch (_) {}

  const clientBoot = localStorage.getItem('travelai_boot');
  if (serverBoot && serverBoot !== clientBoot) {
    // Server restarted → wipe client state for fresh user
    localStorage.removeItem('travelai_trips');
    localStorage.setItem('travelai_boot', serverBoot);
  }

  try {
    const saved = JSON.parse(localStorage.getItem('travelai_trips') || '[]');
    if (Array.isArray(saved) && saved.length > 0) {
      trips = saved.map(migrateTrip);
      activeTripIdx = trips.length - 1;
      persistTrips();
      renderAllMessages();
      renderItinerary();
      renderTripList();
      return;
    }
  } catch (e) { /* ignore */ }

  createTrip();
})();

function migrateTrip(trip) {
  if (Array.isArray(trip.messages)) return trip;
  const messages = [
    { role: 'agent', content: { type: 'welcome', data: "Hello! I'm your AI travel assistant. Tell me where you'd like to go, and I'll plan the perfect trip for you.\n\n**Tips**\n🌗 Toggle light/dark mode — button next to the logo (top-left)\n🔇 A stop button appears at the top-right when I'm speaking" } }
  ];
  return {
    id: trip.id || uuid(),
    name: trip.name || 'New Trip',
    messages,
    itinerary: null,
  };
}
