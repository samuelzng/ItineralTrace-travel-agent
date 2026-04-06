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
let pendingImageId = null;    // image_id from /upload-image
let pendingImageUrl = null;   // local preview URL

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

  itineraryEl.innerHTML = allHtml;
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
    itineraries: [],
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

  // Capture and clear any pending image
  const imageId = pendingImageId;
  const imageUrl = pendingImageUrl;
  clearPendingImage();

  // Push user message to data model and render
  const trip = getActiveTrip();
  if (!trip) return;
  const userContent = imageUrl ? { text: msg, image_url: imageUrl } : msg;
  trip.messages.push({ role: 'user', content: userContent });
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

  const gen = _sendGeneration;
  chatAbortController = new AbortController();
  const typingId = appendTyping();

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, session_id: getSessionId(), image_id: imageId || '' }),
      signal: chatAbortController.signal,
    });
    if (gen !== _sendGeneration) return;
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    // Read SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (gen !== _sendGeneration) return;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();  // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch (_) { continue; }

        if (data.event === 'progress') {
          updateTypingStatus(typingId, data.text);

        } else if (data.event === 'done') {
          removeTyping(typingId);
          const resp = data.response;
          trip.messages.push({ role: 'agent', content: resp });
          messagesEl.appendChild(buildAgentBubble(resp, true));
          scrollToBottom();

          if (resp.type === 'itinerary' && resp.data) {
            trip.itineraries.push(resp.data);
            trip.name = resp.data.destination || trip.name;
            renderItinerary();
            renderTripList();
            showItineraryBadge();
          }

          if (data.audio_url) playTTS(data.audio_url);
          persistTrips();
          loadMemoriesUI();

        } else if (data.event === 'error') {
          removeTyping(typingId);
          const errText = `Something went wrong: ${esc(data.text)}`;
          trip.messages.push({ role: 'agent', content: errText });
          messagesEl.appendChild(buildAgentBubble(errText));
          scrollToBottom();
        }
      }
    }

  } catch (err) {
    if (gen !== _sendGeneration) return;
    removeTyping(typingId);
    if (err.name === 'AbortError') return;
    const detail = navigator.onLine ? esc(err.message) : 'You appear to be offline.';
    const errText = `Something went wrong: ${detail}`;
    trip.messages.push({ role: 'agent', content: errText });
    messagesEl.appendChild(buildAgentBubble(errText));
    scrollToBottom();
  } finally {
    chatAbortController = null;
    setProcessing(false);
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
    <div class="message__bubble">
      <div class="typing-dots"><span></span><span></span><span></span></div>
      <div class="typing-status"></div>
    </div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
  return id;
}

function updateTypingStatus(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const statusEl = el.querySelector('.typing-status');
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.style.display = text ? 'block' : 'none';
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
      <span class="memory-text">${esc(m.text)}</span>
      <button class="memory-delete" data-id="${esc(m.id)}" title="Forget">&times;</button>
    </div>
  `).join('');
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
   IMAGE UPLOAD & PASTE
   ══════════════════════════════════════════════════════════════════════════════ */

function clearPendingImage() {
  pendingImageId = null;
  pendingImageUrl = null;
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
