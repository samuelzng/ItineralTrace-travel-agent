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
// Per-trip abort controllers stored on trip._abortCtrl
let mediaRecorder = null;
let audioChunks = [];
let _sendGeneration = 0;
let pendingImageId = null;    // image_id from /upload-image
let pendingImageUrl = null;   // local preview URL

/* ── Map state (declared early so switchPanel/enterSplitView can reference) ── */
let _map = null;
let _mapTileLayer = null;
let _mapMarkers = [];
let _mapLines = [];
let _mapLegend = null;
let _mapGeneration = 0;
const _geocodeCache = {};

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
const imageInput        = document.getElementById('image-input');
const btnUpload         = document.getElementById('btn-upload');
const imagePreviewBar   = document.getElementById('image-preview-bar');
const imagePreviewThumb = document.getElementById('image-preview-thumb');
const imagePreviewRemove= document.getElementById('image-preview-remove');
const panels            = { chat: document.getElementById('panel-chat'), itinerary: document.getElementById('panel-itinerary') };
const btnNewTrip        = document.getElementById('btn-new-trip');
const btnDeleteTrip     = document.getElementById('btn-delete-trip');
const tripListEl        = document.getElementById('trip-list');
const exportActions     = document.getElementById('export-actions');
const btnPrintItin      = document.getElementById('btn-print-itinerary');

/* ══════════════════════════════════════════════════════════════════════════════
   RENDERING — all HTML is generated here from structured data
   ══════════════════════════════════════════════════════════════════════════════ */

/* ── Message rendering ─────────────────────────────────────────────────────── */
function renderAllMessages() {
  messagesEl.innerHTML = '';
  const trip = getActiveTrip();
  if (!trip) return;
  const msgs = trip.messages;

  // Show welcome hero if only the welcome message exists
  if (msgs.length === 1 && msgs[0].role === 'agent'
      && typeof msgs[0].content === 'object' && msgs[0].content.type === 'welcome') {
    messagesEl.appendChild(buildWelcomeHero());
    return;
  }

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    // Skip welcome messages in normal chat view
    if (msg.role === 'agent' && typeof msg.content === 'object' && msg.content.type === 'welcome') continue;
    const isLast = (i === msgs.length - 1);
    if (msg.role === 'user') {
      messagesEl.appendChild(buildUserBubble(msg.content));
    } else {
      messagesEl.appendChild(buildAgentBubble(msg.content, isLast));
    }
  }
  scrollToBottom();
}

function buildUserBubble(content) {
  const div = document.createElement('div');
  div.className = 'message message--user';
  // content can be a string or {text, image_url}
  const text = typeof content === 'string' ? content : content.text;
  const imgUrl = typeof content === 'object' ? content.image_url : null;
  const imgHtml = imgUrl
    ? `<img src="${esc(imgUrl)}" class="message__image" loading="lazy" onerror="this.style.display='none'" />`
    : '';
  div.innerHTML = `
    <div class="message__avatar">👤</div>
    <div class="message__bubble">${imgHtml}<p>${esc(text)}</p></div>`;
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
  if (typeof content === 'object') return content.data || content.text || '';
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
  const asksWhere = /where.*go|where.*like to|what.*destination/.test(lower);
  const asksDays = /how many days|how long|number of days/.test(lower);
  if ((asksWhere || asksDays) && !/pace|relaxed|interest|cuisine/.test(lower)) {
    if (asksDays && !asksWhere) {
      // Agent already knows destination — only ask for days
      return '__DAYS_ONLY_FORM__';
    }
    return '__DESTINATION_FORM__';
  }

  // Combined: Agent asking about PACE AND interests in one question
  const asksPace = /pace|relaxed.*moderate.*packed|relaxed.*packed/.test(lower);
  const asksInterest = /interest|history.*food.*nature|food.*nature.*shopping/.test(lower);
  if (asksPace && asksInterest) return '__PACE_AND_INTEREST__';

  // Step 2: Agent asking about PACE only
  if (asksPace && !asksInterest) return PACE_CHIPS;

  // Step 3: Agent ASKING about interests only
  if (asksInterest && !asksPace) return INTEREST_CHIPS;

  // Agent asking about meal times
  if (/lunch.*dinner|meal\s*time/.test(lower)) return MEAL_CHIPS;

  return null;
}

function _buildDaysRow() {
  return `
    <div class="inline-form-row">
      <label>How many days?</label>
      <div class="inline-days-row">
        <button class="chip chip--day" data-days="1">1</button>
        <button class="chip chip--day" data-days="2">2</button>
        <button class="chip chip--day" data-days="3">3</button>
        <input type="number" class="inline-input inline-days-input" id="inline-days" min="1" max="30" placeholder="other" />
      </div>
    </div>`;
}

function _buildChipsOrForm(detected) {
  if (!detected) return '';
  if (detected === '__DAYS_ONLY_FORM__') {
    return `
      <div class="inline-form" data-days-only="true">
        ${_buildDaysRow()}
        <button class="btn-inline-submit" id="inline-submit" disabled>Let's go</button>
      </div>`;
  }
  if (detected === '__DESTINATION_FORM__') {
    return `
      <div class="inline-form">
        <div class="inline-form-row">
          <label>Destination</label>
          <input type="text" class="inline-input" id="inline-dest" placeholder="e.g. Hong Kong, Tokyo, Paris" />
        </div>
        ${_buildDaysRow()}
        <button class="btn-inline-submit" id="inline-submit" disabled>Let's go</button>
      </div>`;
  }
  if (detected === '__PACE_AND_INTEREST__') {
    const paceHtml = PACE_CHIPS.map(s => `<button class="chip chip--pick" data-group="pace">${esc(s)}</button>`).join('');
    const interestHtml = INTEREST_CHIPS.map(s => `<button class="chip chip--pick" data-group="interest">${esc(s)}</button>`).join('');
    return `
      <div class="inline-form" data-combo="pace-interest">
        <div class="inline-form-row"><label>Pace</label><div class="inline-chips">${paceHtml}</div></div>
        <div class="inline-form-row"><label>Interests</label><div class="inline-chips">${interestHtml}</div></div>
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
      <p style="margin-top:10px"><button class="btn-view-itinerary" onclick="enterSplitView()">View Itinerary →</button></p>`;
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

  // Wire up simple chip clicks (exclude .chip--pick used in combo forms)
  div.querySelectorAll('.chip:not(.chip--day):not(.chip--pick)').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.inline-chips').forEach(el => el.remove());
      sendMessage(btn.textContent);
    });
  });

  // Wire up destination/days form
  const inlineForm = div.querySelector('.inline-form');
  if (inlineForm) {
    const isCombo = !!inlineForm.dataset.combo;
    const isDaysOnly = inlineForm.dataset.daysOnly === 'true';
    const destInput = inlineForm.querySelector('#inline-dest');  // null when days-only
    const daysInput = inlineForm.querySelector('#inline-days');  // null in combo forms
    const submitBtn = inlineForm.querySelector('#inline-submit');

    if (isCombo) {
      // ── Combo form (pace + interest) ──
      const selected = {};  // group → label

      inlineForm.querySelectorAll('.chip--pick').forEach(btn => {
        btn.addEventListener('click', () => {
          const group = btn.dataset.group;
          // Deselect siblings in same group
          inlineForm.querySelectorAll(`.chip--pick[data-group="${group}"]`).forEach(b => b.classList.remove('chip--selected'));
          btn.classList.add('chip--selected');
          selected[group] = btn.textContent;
          // Enable submit when all groups have a selection
          const groups = new Set([...inlineForm.querySelectorAll('.chip--pick')].map(b => b.dataset.group));
          submitBtn.disabled = Object.keys(selected).length < groups.size;
        });
      });

      submitBtn.addEventListener('click', () => {
        const parts = Object.values(selected);
        if (!parts.length) return;
        inlineForm.remove();
        sendMessage(parts.join(', '));
      });
    } else {
      // ── Destination / days form ──
      function getDays() {
        const typed = parseInt(daysInput.value);
        if (typed > 0) return typed;
        const sel = inlineForm.querySelector('.chip--day.chip--selected');
        return sel ? parseInt(sel.dataset.days) : 0;
      }

      function validate() {
        const hasDest = isDaysOnly || (destInput && destInput.value.trim());
        submitBtn.disabled = !hasDest || !getDays();
      }

      // Day chip selection
      inlineForm.querySelectorAll('.chip--day').forEach(btn => {
        btn.addEventListener('click', () => {
          inlineForm.querySelectorAll('.chip--day').forEach(b => b.classList.remove('chip--selected'));
          btn.classList.add('chip--selected');
          if (daysInput) daysInput.value = btn.dataset.days;
          validate();
        });
      });

      if (daysInput) {
        daysInput.addEventListener('input', () => {
          inlineForm.querySelectorAll('.chip--day').forEach(b => b.classList.remove('chip--selected'));
          validate();
        });
      }

      if (destInput) destInput.addEventListener('input', validate);

      // Submit
      submitBtn.addEventListener('click', () => {
        const days = getDays();
        if (!days) return;
        if (isDaysOnly) {
          inlineForm.remove();
          sendMessage(`${days} day${days > 1 ? 's' : ''}`);
        } else {
          const dest = destInput ? destInput.value.trim() : '';
          if (!dest) return;
          inlineForm.remove();
          sendMessage(`${dest}, ${days} day${days > 1 ? 's' : ''}`);
        }
      });

      // Enter submits
      const inputs = [daysInput, destInput].filter(Boolean);
      inputs.forEach(el => {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !submitBtn.disabled) {
            e.preventDefault();
            submitBtn.click();
          }
        });
      });
    }
  }

  return div;
}

/* ── Welcome Hero ─────────────────────────────────────────────────────────── */
function buildWelcomeHero() {
  const chips = [
    { icon: '🗼', msg: 'Plan a 2-day trip to Tokyo' },
    { icon: '🌤', msg: "What's the weather in Paris this weekend?" },
    { icon: '🏛', msg: 'Find attractions in Bangkok' },
    { icon: '🍝', msg: 'Suggest restaurants in Rome' },
  ];
  const div = document.createElement('div');
  div.className = 'welcome-hero';
  div.innerHTML = `
    <div class="welcome-hero-glow">✈</div>
    <h2 class="welcome-hero-title">Where to next?</h2>
    <p class="welcome-hero-subtitle">Tell me your destination and I'll plan the perfect trip — with real places, live weather, and walking routes.</p>
    <div class="welcome-hero-chips">
      ${chips.map(c => `<button class="welcome-chip" data-msg="${esc(c.msg)}">${c.icon} ${esc(c.msg)}</button>`).join('')}
    </div>
    <div class="welcome-hero-tips">
      <span>🌗 Dark / light mode</span>
      <span>🎙 Click mic to speak</span>
      <span>📷 Paste or upload images</span>
    </div>`;

  div.querySelectorAll('.welcome-chip').forEach(btn => {
    btn.addEventListener('click', () => sendMessage(btn.dataset.msg));
  });
  return div;
}

/* ── Itinerary rendering ───────────────────────────────────────────────────── */
function renderItinerary() {
  const trip = getActiveTrip();
  const itineraries = trip?.itineraries || [];
  if (!itineraries.length) {
    itineraryEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗺</div>
        <p>Your itinerary will appear here once you ask me to plan a trip.</p>
      </div>`;
    itinerarySubtitle.textContent = DEFAULT_SUBTITLE;
    if (exportActions) exportActions.hidden = true;
    _destroyMap();
    return;
  }

  // Subtitle shows the latest itinerary info
  const latest = itineraries[itineraries.length - 1];
  const latestRange = latest.dates ? `${latest.dates.start} → ${latest.dates.end}` : '';
  itinerarySubtitle.textContent =
    (latest.destination || '') + (latestRange ? '  •  ' + latestRange : '')
    + (itineraries.length > 1 ? `  (${itineraries.length} trips)` : '');

  // Render all itineraries, newest first
  const allHtml = itineraries.slice().reverse().map(itin => {
    const dateRange = itin.dates ? `${itin.dates.start} → ${itin.dates.end}` : '';
    const daysHtml = (itin.days || []).map(renderDay).join('\n');
    return `
      <div class="itinerary">
        <div class="itinerary-header">
          <h2 class="destination">${esc(itin.destination || 'Unknown')}</h2>
          <span class="date-range">${esc(dateRange)}</span>
          <p class="weather-summary">${esc(itin.weather_summary || '')}</p>
        </div>
        <div class="days">${daysHtml}</div>
      </div>`;
  }).join('\n');

  // Prepend map container, then itinerary content
  itineraryEl.innerHTML = `
    <div class="itinerary-map-wrap" id="itinerary-map-wrap">
      <div id="itinerary-map"></div>
      <div class="map-loading" id="map-loading">Placing pins on map…</div>
    </div>` + allHtml;
  if (exportActions) exportActions.hidden = false;
  updateItineraryMap(latest);
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

  const imgHtml = a.image_url
    ? `<img src="${esc(a.image_url)}" class="activity-img" loading="lazy" onerror="this.style.display='none'" />`
    : '';

  return `
    <div class="activity">
      <div class="activity-main">
        <div class="activity-time">${esc(a.time || '')}</div>
        <div class="activity-dot-line">
          <div class="activity-dot"></div>
          ${lineHtml}
        </div>
        <div class="activity-body">
          ${imgHtml}
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

function cancelInFlight(trip) {
  // Cancel the specific trip's in-flight request (if any)
  const t = trip || getActiveTrip();
  if (t && t._abortCtrl) { t._abortCtrl.abort(); delete t._abortCtrl; }
  if (t) { t.isGenerating = false; t.lastProgress = ''; delete t._typingId; }
  stopTTS();
  document.querySelectorAll('.message--typing').forEach(el => el.remove());
  setProcessing(false);
}

/* ── Trip CRUD ─────────────────────────────────────────────────────────────── */
async function createTrip() {
  // Don't cancel in-flight requests — let background trips finish.
  // Only stop audio and clean up typing UI for the current view.
  stopTTS();
  document.querySelectorAll('.message--typing').forEach(el => el.remove());
  setProcessing(false);

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
    itineraries: [],
    isGenerating: false,
    lastProgress: '',
    imageId: null,
    imagePreview: null,
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
  // Do NOT cancel in-flight requests — let the generation continue in the background.
  stopTTS();
  activeTripIdx = idx;
  persistTrips();
  renderAllMessages();
  renderItinerary();
  renderTripList();

  // Restore image preview for the target trip
  const target = getActiveTrip();
  if (target?.imagePreview) {
    pendingImageId = target.imageId;
    pendingImageUrl = target.imagePreview;
    imagePreviewThumb.src = target.imagePreview;
    imagePreviewBar.hidden = false;
  } else {
    clearPendingImage();
  }

  // Restore UI state for the target trip
  if (target && target.isGenerating) {
    setProcessing(true);
    const typingId = appendTyping();
    // Store the typing element ID so the SSE handler can find it
    target._typingId = typingId;
    if (target.lastProgress) updateTypingStatus(typingId, target.lastProgress);
  } else {
    setProcessing(false);
  }
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
  if (!msg) return;
  const currentTrip = getActiveTrip();
  if (!currentTrip || currentTrip.isGenerating) return;

  inputText.value = '';
  inputText.style.height = 'auto';

  // Capture and clear any pending image (per-trip)
  const imageId = currentTrip.imageId || pendingImageId || '';
  const imageUrl = currentTrip.imagePreview || pendingImageUrl;
  currentTrip.imageId = null;
  currentTrip.imagePreview = null;
  clearPendingImage();

  // Push user message to data model and render
  const trip = getActiveTrip();
  if (!trip) return;
  const userContent = imageUrl ? { text: msg, image_url: imageUrl } : msg;
  trip.messages.push({ role: 'user', content: userContent });
  // Clear welcome hero if present
  if (messagesEl.querySelector('.welcome-hero')) {
    messagesEl.innerHTML = '';
  }
  messagesEl.appendChild(buildUserBubble(userContent));
  document.querySelectorAll('.inline-chips').forEach(el => el.remove());  // clear chips
  scrollToBottom();
  setProcessing(true);

  // Auto-name from first user message
  if (trip.name === 'New Trip') {
    trip.name = msg.length > 40 ? msg.slice(0, 37) + '...' : msg;
    persistTrips();
    renderTripList();
  }

  const gen = ++_sendGeneration;
  _ttsGeneration = gen;  // only play audio from this request
  // Use trip.id for stable identity — survives persistTrips() / array rebuilds
  const tripId = trip.id;
  const findTrip = () => trips.find(t => t.id === tripId);
  const isTripActive = () => {
    const at = getActiveTrip();
    return at && at.id === tripId;
  };
  // Per-trip abort controller so switching doesn't kill other trips' requests
  const abortCtrl = new AbortController();
  trip._abortCtrl = abortCtrl;
  // Store typing element ID on trip so switchTrip can recreate it
  const initialTypingId = appendTyping();
  trip._typingId = initialTypingId;
  const getTypingId = () => {
    const t = findTrip();
    return t ? t._typingId : initialTypingId;
  };

  trip.isGenerating = true;
  trip.lastProgress = '';

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, session_id: trip.id, image_id: imageId || '' }),
      signal: abortCtrl.signal,
    });
    if (!findTrip()) return;  // trip was deleted
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    // Read SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!findTrip()) return;  // trip was deleted

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();  // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch (_) { continue; }

        if (data.event === 'progress') {
          // Always persist progress to the trip data model
          const t = findTrip();
          if (t) t.lastProgress = data.text;
          if (isTripActive()) updateTypingStatus(getTypingId(), data.text);

        } else if (data.event === 'done') {
          const t = findTrip();
          const typingIdToRemove = getTypingId();
          if (t) { t.isGenerating = false; t.lastProgress = ''; delete t._typingId; delete t._abortCtrl; }
          if (isTripActive()) removeTyping(typingIdToRemove);
          const resp = data.response;
          if (t) t.messages.push({ role: 'agent', content: resp });
          if (isTripActive()) {
            messagesEl.appendChild(buildAgentBubble(resp, true));
            scrollToBottom();
          }

          if (resp.type === 'itinerary' && resp.data) {
            if (t) {
              t.itineraries.push(resp.data);
              t.name = resp.data.destination || t.name;
            }
            if (isTripActive()) {
              renderItinerary();
              showItineraryBadge();
            }
            renderTripList();
          }

          if (isTripActive() && data.audio_url) playTTS(data.audio_url, gen);
          persistTrips();
          loadMemoriesUI();

        } else if (data.event === 'error') {
          const t = findTrip();
          const typingIdToRemove = getTypingId();
          if (t) { t.isGenerating = false; t.lastProgress = ''; delete t._typingId; delete t._abortCtrl; }
          if (isTripActive()) removeTyping(typingIdToRemove);
          const errText = `Something went wrong: ${esc(data.text)}`;
          if (t) t.messages.push({ role: 'agent', content: errText });
          if (isTripActive()) {
            messagesEl.appendChild(buildAgentBubble(errText));
            scrollToBottom();
          }
        }
      }
    }

  } catch (err) {
    const t = findTrip();
    const typingIdToRemove = getTypingId();
    if (t) { t.isGenerating = false; t.lastProgress = ''; delete t._typingId; delete t._abortCtrl; }
    if (isTripActive()) removeTyping(typingIdToRemove);
    if (err.name === 'AbortError') return;
    if (!t) return;  // trip was deleted
    const detail = navigator.onLine ? esc(err.message) : 'You appear to be offline.';
    const errText = `Something went wrong: ${detail}`;
    if (t) t.messages.push({ role: 'agent', content: errText });
    if (isTripActive()) {
      messagesEl.appendChild(buildAgentBubble(errText));
      scrollToBottom();
    }
    persistTrips();
  } finally {
    if (isTripActive()) setProcessing(false);
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
  // Exit split mode when using nav tabs
  exitSplitView();
  navItems.forEach(b => b.classList.remove('active'));
  document.querySelector(`.nav-item[data-panel="${target}"]`)?.classList.add('active');
  mobileNavItems.forEach(b => b.classList.remove('active'));
  document.querySelector(`.mobile-nav-item[data-panel="${target}"]`)?.classList.add('active');
  Object.entries(panels).forEach(([key, el]) => el.classList.toggle('panel--hidden', key !== target));
  if (target === 'itinerary') {
    itineraryBadge.hidden = true;
    if (mobileBadge) mobileBadge.hidden = true;
    requestAnimationFrame(() => { if (_map) _map.invalidateSize(); });
  }
}

const splitHandle = document.getElementById('split-handle');

function enterSplitView() {
  // On small screens, fall back to full panel switch
  if (window.innerWidth < 900) {
    switchPanel('itinerary');
    return;
  }
  const mainEl = document.querySelector('.main');
  mainEl.classList.add('main--split');
  // Ensure both panels are visible
  panels.chat.classList.remove('panel--hidden');
  panels.itinerary.classList.remove('panel--hidden');
  // Show resize handle
  if (splitHandle) splitHandle.hidden = false;
  // Reset any custom widths from previous drag
  panels.chat.style.flex = '';
  panels.itinerary.style.flex = '';
  itineraryBadge.hidden = true;
  if (mobileBadge) mobileBadge.hidden = true;
  // Scroll itinerary to top
  document.getElementById('itinerary-container')?.scrollTo({ top: 0, behavior: 'smooth' });
  requestAnimationFrame(() => { if (_map) _map.invalidateSize(); });
}

function exitSplitView() {
  document.querySelector('.main').classList.remove('main--split');
  if (splitHandle) splitHandle.hidden = true;
  // Reset custom widths
  panels.chat.style.flex = '';
  panels.itinerary.style.flex = '';
}

/* ── Split handle drag ────────────────────────────────────────────────────── */
if (splitHandle) {
  let isDragging = false;

  splitHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    splitHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const mainEl = document.querySelector('.main');
    const mainRect = mainEl.getBoundingClientRect();
    const offset = e.clientX - mainRect.left;
    const totalWidth = mainRect.width;
    // Clamp: chat min 30%, max 80%
    const chatRatio = Math.max(0.3, Math.min(0.8, offset / totalWidth));
    const itinRatio = 1 - chatRatio;
    panels.chat.style.flex = `${chatRatio}`;
    panels.itinerary.style.flex = `${itinRatio}`;
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    splitHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

navItems.forEach(btn => btn.addEventListener('click', () => switchPanel(btn.dataset.panel)));
mobileNavItems.forEach(btn => btn.addEventListener('click', () => switchPanel(btn.dataset.panel)));

// Collapse button closes split view, returns to chat
const btnCollapseSplit = document.getElementById('btn-collapse-split');
if (btnCollapseSplit) btnCollapseSplit.addEventListener('click', () => switchPanel('chat'));
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

const ttsControls = document.getElementById('tts-controls');
const btnStopTTS  = document.getElementById('btn-stop-tts');
const btnPlayTTS  = document.getElementById('btn-play-tts');

let _ttsStopped = false;  // true only when user explicitly stops
let _ttsGeneration = 0;   // tracks which request's audio we should play

function showTTSControls(playing) {
  ttsControls.hidden = false;
  btnStopTTS.hidden = !playing;
  btnPlayTTS.hidden = playing;
}

function hideTTSControls() {
  ttsControls.hidden = true;
  btnStopTTS.hidden = true;
  btnPlayTTS.hidden = true;
}

function playTTS(url, gen) {
  // Ignore stale audio from a previous request
  if (gen !== undefined && gen !== _ttsGeneration) return;
  if (!url) return;
  _ttsStopped = false;
  ttsAudio.preload = 'auto';
  ttsAudio.src = url;
  ttsAudio.play().catch((err) => {
    console.warn('TTS play blocked:', err);
    hideTTSControls();
  });
  showTTSControls(true);
}

function stopTTS(clearSrc = true) {
  _ttsStopped = true;
  ttsAudio.pause();
  if (clearSrc) {
    ttsAudio.src = '';
    hideTTSControls();
  } else {
    // Pause only — show Play button for resume
    showTTSControls(false);
  }
}

function resumeTTS() {
  if (!ttsAudio.src || ttsAudio.ended) return;
  _ttsStopped = false;
  ttsAudio.play().catch((err) => {
    console.warn('TTS resume blocked:', err);
    hideTTSControls();
  });
  showTTSControls(true);
}

ttsAudio.addEventListener('ended', () => { hideTTSControls(); });
ttsAudio.addEventListener('error', () => {
  console.warn('TTS audio failed to load:', ttsAudio.src);
  ttsAudio.src = '';
  hideTTSControls();
});
ttsAudio.addEventListener('playing', () => {
  if (!_ttsStopped) showTTSControls(true);
});
ttsAudio.addEventListener('pause', () => {
  if (_ttsStopped && ttsAudio.src && !ttsAudio.ended) showTTSControls(false);
});
btnStopTTS.addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  stopTTS(false);  // pause only, allow resume
});
btnPlayTTS.addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  resumeTTS();
});

let _typingCounter = 0;
function appendTyping() {
  const id = 'typing-' + (++_typingCounter);
  const div = document.createElement('div');
  div.className = 'message message--agent message--typing';
  div.id = id;
  div.innerHTML = `
    <div class="message__avatar">✈</div>
    <div class="message__bubble">
      <div class="typing-dots"><span></span><span></span><span></span></div>
      <div class="typing-status"></div>
      <div class="trace-steps"></div>
    </div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
  return id;
}

const _TRACE_COLLAPSE_THRESHOLD = 3;

function _maybeCollapseTrace(stepsEl) {
  /**Auto-collapse trace when done steps exceed threshold.
   * Hides older steps behind a clickable "N tools completed" summary.
   */
  const doneSteps = stepsEl.querySelectorAll('.trace-step--done');
  // Don't re-collapse if already collapsed
  if (stepsEl.querySelector('.trace-collapsed') || doneSteps.length <= _TRACE_COLLAPSE_THRESHOLD) return;

  // Wrap all but the last done step in a collapsible group
  const toHide = Array.from(doneSteps).slice(0, -1);
  const wrapper = document.createElement('div');
  wrapper.className = 'trace-collapsed';
  const toggle = document.createElement('div');
  toggle.className = 'trace-collapse-toggle';
  toggle.textContent = `${toHide.length} tools completed`;
  toggle.addEventListener('click', () => {
    const hidden = wrapper.querySelector('.trace-collapsed-items');
    if (hidden) {
      hidden.classList.toggle('trace-collapsed--open');
      toggle.textContent = hidden.classList.contains('trace-collapsed--open')
        ? `Hide ${toHide.length} tools`
        : `${toHide.length} tools completed`;
    }
    scrollToBottom();
  });
  wrapper.appendChild(toggle);
  const itemsWrap = document.createElement('div');
  itemsWrap.className = 'trace-collapsed-items';
  for (const s of toHide) itemsWrap.appendChild(s);
  wrapper.appendChild(itemsWrap);
  stepsEl.prepend(wrapper);
}

function updateTypingStatus(id, text) {
  const el = document.getElementById(id);
  if (!el) return;

  // Tool result summary — append as a completed trace step
  if (text.startsWith('result:')) {
    const parts = text.split(':');
    const toolName = parts[1] || '';
    const summary = parts.slice(2).join(':');
    const stepsEl = el.querySelector('.trace-steps');
    if (stepsEl) {
      // Mark previous active step as done
      const prev = stepsEl.querySelector('.trace-step--active');
      if (prev) {
        prev.classList.remove('trace-step--active');
        prev.classList.add('trace-step--done');
      }
      const step = document.createElement('div');
      step.className = 'trace-step trace-step--done';
      step.innerHTML = `<span class="trace-icon">&#10003;</span> <span class="trace-tool">${esc(toolName)}</span> <span class="trace-summary">${esc(summary)}</span>`;
      stepsEl.appendChild(step);
      _maybeCollapseTrace(stepsEl);
    }
    scrollToBottom();
    return;
  }

  // Regular progress — show as active step
  const statusEl = el.querySelector('.typing-status');
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.style.display = text ? 'block' : 'none';
  }

  // Also add as active trace step for tool calls
  const stepsEl = el.querySelector('.trace-steps');
  if (stepsEl && (text.startsWith('Searching') || text.startsWith('Checking weather') || text.startsWith('Saving') || text.startsWith('Remembering'))) {
    // Mark previous active step as done
    const prev = stepsEl.querySelector('.trace-step--active');
    if (prev) {
      prev.classList.remove('trace-step--active');
      prev.classList.add('trace-step--done');
    }
    const step = document.createElement('div');
    step.className = 'trace-step trace-step--active';
    step.innerHTML = `<span class="trace-icon trace-spinner"></span> ${esc(text)}`;
    stepsEl.appendChild(step);
  }
  scrollToBottom();
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
  // Update map tiles to match theme
  if (typeof _mapTileLayer !== 'undefined' && _mapTileLayer) {
    _mapTileLayer.setUrl(theme === 'light'
      ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png');
  }
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// Restore saved theme
applyTheme(localStorage.getItem('travelai_theme') || 'dark');

/* ══════════════════════════════════════════════════════════════════════════════
   MEMORY PANEL
   ══════════════════════════════════════════════════════════════════════════════ */

const memoryToggle  = document.getElementById('memory-toggle');
const memoryPanel   = document.getElementById('memory-panel');
const memoryArrow   = document.getElementById('memory-arrow');
const memoryListEl  = document.getElementById('memory-list');
const memoryCount   = document.getElementById('memory-count');
const memoryAddInput = document.getElementById('memory-add-input');
const memoryAddBtn  = document.getElementById('memory-add-btn');

memoryToggle.addEventListener('click', () => {
  const isOpen = !memoryPanel.hidden;
  memoryPanel.hidden = isOpen;
  memoryArrow.classList.toggle('open', !isOpen);
  if (!isOpen) loadMemoriesUI();
});

async function loadMemoriesUI() {
  try {
    const res = await fetch('/memories');
    if (!res.ok) return;
    const memories = await res.json();
    renderMemories(memories);
  } catch (_) {}
}

function renderMemories(memories) {
  if (!memories.length) {
    memoryListEl.innerHTML = '<div class="memory-empty">No memories yet. I\'ll learn your preferences as we chat.</div>';
    memoryCount.hidden = true;
    return;
  }
  memoryCount.textContent = memories.length;
  memoryCount.hidden = false;
  memoryListEl.innerHTML = memories.map(m => `
    <div class="memory-item" data-id="${esc(m.id)}">
      <span class="memory-text" title="Click to edit">${esc(m.text)}</span>
      <button class="memory-delete" data-id="${esc(m.id)}" title="Forget">&times;</button>
    </div>
  `).join('');
  // Delete buttons
  memoryListEl.querySelectorAll('.memory-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      try {
        await fetch(`/memories/${id}`, { method: 'DELETE' });
        loadMemoriesUI();
      } catch (_) {}
    });
  });
  // Inline edit — click text to edit
  memoryListEl.querySelectorAll('.memory-text').forEach(span => {
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = span.closest('.memory-item');
      const id = item.dataset.id;
      const oldText = span.textContent;
      // Replace with input
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'memory-edit-input';
      input.value = oldText;
      span.replaceWith(input);
      input.focus();
      input.select();

      async function commitEdit() {
        const newText = input.value.trim();
        if (!newText || newText === oldText) {
          loadMemoriesUI();
          return;
        }
        try {
          await fetch(`/memories/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: newText }),
          });
          loadMemoriesUI();
        } catch (_) { loadMemoriesUI(); }
      }

      input.addEventListener('blur', commitEdit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { loadMemoriesUI(); }
      });
    });
  });
}

async function addMemoryManual() {
  const text = memoryAddInput.value.trim();
  if (!text) return;
  memoryAddInput.value = '';
  try {
    await fetch('/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    loadMemoriesUI();
  } catch (_) {}
}

memoryAddBtn.addEventListener('click', addMemoryManual);
memoryAddInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addMemoryManual(); }
});

/* ══════════════════════════════════════════════════════════════════════════════
   EXPORT ITINERARY
   ══════════════════════════════════════════════════════════════════════════════ */

function printItinerary() {
  window.print();
}

if (btnPrintItin) btnPrintItin.addEventListener('click', printItinerary);

/* ══════════════════════════════════════════════════════════════════════════════
   ITINERARY MAP (Leaflet + Nominatim geocoding)
   ══════════════════════════════════════════════════════════════════════════════ */

const DAY_COLORS = ['#2f81f7','#3fb950','#d29922','#f85149','#a371f7','#e07c38','#56d4dd','#db61a2'];

function _destroyMap() {
  if (_map) { _map.remove(); _map = null; _mapTileLayer = null; _mapLegend = null; }
  _mapMarkers = [];
  _mapLines = [];
}

function _initMap() {
  _destroyMap();
  const el = document.getElementById('itinerary-map');
  if (!el) return;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  _map = L.map(el, { zoomControl: true, scrollWheelZoom: true });
  _mapTileLayer = L.tileLayer(
    theme === 'light'
      ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>', maxZoom: 19 }
  ).addTo(_map);
}

function _numberedIcon(num, color) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.35);border:2.5px solid #fff;font-family:Inter,sans-serif">${num}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

async function _geocode(query) {
  if (_geocodeCache[query] !== undefined) return _geocodeCache[query];

  // Try English first (best for international place names on OSM)
  const result = await _geocodeOnce(query, 'en');
  if (result) { _geocodeCache[query] = result; return result; }

  // Fallback: try with Chinese locale + country code (helps for Chinese POIs)
  const hasCJK = /[\u4e00-\u9fff]/.test(query);
  if (!hasCJK) {
    // If query is English, also try without accept-language (raw OSM)
    const raw = await _geocodeOnce(query, '');
    if (raw) { _geocodeCache[query] = raw; return raw; }
  } else {
    const cn = await _geocodeOnce(query, 'zh', 'cn');
    if (cn) { _geocodeCache[query] = cn; return cn; }
  }

  // Don't cache failures — transient errors shouldn't permanently block retries
  return null;
}

async function _geocodeOnce(query, lang, countrycode) {
  try {
    let url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    if (lang) url += `&accept-language=${lang}`;
    if (countrycode) url += `&countrycodes=${countrycode}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.length) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (_) {}
  return null;
}

/** Haversine distance in km between two {lat, lng} objects. */
function _haversineDist(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

async function updateItineraryMap(itinerary) {
  if (!itinerary) {
    _destroyMap();
    return;
  }

  const gen = ++_mapGeneration;
  // Clear geocode cache to avoid stale null entries from prior rate-limit failures
  for (const key in _geocodeCache) delete _geocodeCache[key];
  const loadingEl = document.getElementById('map-loading');
  if (loadingEl) loadingEl.hidden = false;

  // Give container a frame to get dimensions
  await new Promise(r => requestAnimationFrame(r));
  _initMap();
  if (!_map) return;

  const dest = itinerary.destination || '';

  // ── Phase 1: Collect all geocode queries upfront ──
  // Always anchor queries to the destination city to prevent Nominatim
  // from resolving ambiguous place names to the wrong country.
  const tasks = []; // { dayIdx, actIdx, queries: string[] }
  for (const [dayIdx, day] of (itinerary.days || []).entries()) {
    for (const [actIdx, act] of (day.activities || []).entries()) {
      const queries = [];
      const addr = act.address || '';
      const addrIsDest = !addr || addr === dest;
      // Primary: place + address + destination (triple anchor)
      if (!addrIsDest) {
        queries.push(`${act.place}, ${addr}, ${dest}`);
      }
      // Fallback: place + destination (always included)
      queries.push(`${act.place}, ${dest}`);
      // Last resort: place name alone
      queries.push(act.place);
      tasks.push({ dayIdx, actIdx, queries });
    }
  }

  // ── Phase 2: Geocode destination first for sanity checking ──
  const destCoord = dest ? await _geocode(dest) : null;

  // ── Phase 3: Geocode activities with rate limiting, trying fallbacks ──
  const resolved = []; // { dayIdx, actIdx, coord }
  for (const task of tasks) {
    if (gen !== _mapGeneration) return;
    let coord = null;
    for (const q of task.queries) {
      if (_geocodeCache[q] !== undefined) {
        coord = _geocodeCache[q];
        if (coord) break;
        continue;
      }
      await new Promise(r => setTimeout(r, 1100));
      coord = await _geocode(q);
      if (coord) break;
    }
    // Sanity check: reject coordinates >300km from destination (wrong country)
    if (coord && destCoord && _haversineDist(coord, destCoord) > 800) {
      console.warn('Geocode outlier rejected:', task.queries[0], coord);
      coord = null;
    }
    if (coord) resolved.push({ ...task, coord });
  }

  if (gen !== _mapGeneration || !_map) return;

  // ── Phase 4: Place all markers and lines at once (no jank) ──
  const allCoords = [];
  const dayLabels = [];
  const dayBuckets = {}; // dayIdx → coords[]
  let actNum = 0;

  for (const r of resolved) {
    const day = itinerary.days[r.dayIdx];
    const act = day.activities[r.actIdx];
    const color = DAY_COLORS[r.dayIdx % DAY_COLORS.length];
    actNum++;

    if (!dayBuckets[r.dayIdx]) {
      dayBuckets[r.dayIdx] = [];
      dayLabels.push({ label: day.date || `Day ${r.dayIdx + 1}`, color });
    }

    const marker = L.marker([r.coord.lat, r.coord.lng], { icon: _numberedIcon(actNum, color) })
      .bindPopup(`<strong>${esc(act.time || '')} — ${esc(act.place || '')}</strong><br><span style="opacity:.7">${esc(act.description || '').slice(0, 120)}</span>`)
      .addTo(_map);
    _mapMarkers.push(marker);
    dayBuckets[r.dayIdx].push([r.coord.lat, r.coord.lng]);
    allCoords.push([r.coord.lat, r.coord.lng]);
  }

  // Day route lines
  for (const dayIdx of Object.keys(dayBuckets)) {
    const coords = dayBuckets[dayIdx];
    if (coords.length > 1 && _map) {
      const color = DAY_COLORS[dayIdx % DAY_COLORS.length];
      const line = L.polyline(coords, {
        color, weight: 3, opacity: 0.65, dashArray: '8 5',
      }).addTo(_map);
      _mapLines.push(line);
    }
  }

  if (gen !== _mapGeneration || !_map) return;
  if (loadingEl) loadingEl.hidden = true;

  // Final fit
  if (allCoords.length > 0) {
    _map.fitBounds(allCoords, { padding: [40, 40], maxZoom: 15 });
  } else if (destCoord && _map) {
    _map.setView([destCoord.lat, destCoord.lng], 12);
    if (loadingEl) loadingEl.hidden = true;
  }

  // Day color legend
  if (dayLabels.length > 1 && _map) {
    const Legend = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd() {
        const div = L.DomUtil.create('div', 'map-legend');
        div.innerHTML = dayLabels.map(d =>
          `<span class="map-legend-item"><span class="map-legend-dot" style="background:${d.color}"></span>${esc(d.label)}</span>`
        ).join('');
        return div;
      }
    });
    _mapLegend = new Legend();
    _map.addControl(_mapLegend);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   IMAGE UPLOAD & PASTE
   ══════════════════════════════════════════════════════════════════════════════ */

function clearPendingImage() {
  pendingImageId = null;
  pendingImageUrl = null;
  const active = getActiveTrip();
  if (active) { active.imageId = null; active.imagePreview = null; }
  imagePreviewBar.hidden = true;
  imagePreviewThumb.src = '';
  imageInput.value = '';
}

async function uploadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const formData = new FormData();
  formData.append('image', file, file.name || 'image.jpg');

  try {
    const res = await fetch('/upload-image', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`Upload failed ${res.status}`);
    const data = await res.json();
    pendingImageId = data.image_id;
    pendingImageUrl = data.url;
    const active = getActiveTrip();
    if (active) {
      active.imageId = data.image_id;
      active.imagePreview = data.url;
    }
    imagePreviewThumb.src = data.url;
    imagePreviewBar.hidden = false;
    inputText.focus();
  } catch (err) {
    console.error('Image upload failed:', err);
  }
}

btnUpload.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  if (imageInput.files.length) uploadImageFile(imageInput.files[0]);
});
imagePreviewRemove.addEventListener('click', clearPendingImage);

// Ctrl+V / Cmd+V paste image
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      uploadImageFile(item.getAsFile());
      return;
    }
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
   INIT — migrate legacy data or create first trip
   ══════════════════════════════════════════════════════════════════════════════ */

(async function init() {
  loadMemoriesUI();

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
  // Migrate old itinerary (single) → itineraries (array)
  if (trip.itinerary && !trip.itineraries) {
    trip.itineraries = [trip.itinerary];
    delete trip.itinerary;
  }
  if (!trip.itineraries) trip.itineraries = [];
  // Reset transient generation state on page reload (SSE connection is gone)
  trip.isGenerating = false;
  trip.lastProgress = '';
  delete trip._typingId;

  if (Array.isArray(trip.messages)) return trip;
  const messages = [
    { role: 'agent', content: { type: 'welcome', data: "Hello! I'm your AI travel assistant. Tell me where you'd like to go, and I'll plan the perfect trip for you.\n\n**Tips**\n🌗 Toggle light/dark mode — button next to the logo (top-left)\n🔇 A stop button appears at the top-right when I'm speaking" } }
  ];
  return {
    id: trip.id || uuid(),
    name: trip.name || 'New Trip',
    messages,
    itineraries: trip.itineraries || [],
  };
}
