'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const SENSORS = ['temp', 'humidity', 'light', 'pressure', 'ozone', 'height'];

const PALETTE = {
  temp:     '#ff6b47',
  humidity: '#4db8ff',
  light:    '#ffd060',
  pressure: '#c084ff',
  ozone:    '#4ade80',
  height:   '#fb923c',
};

// Reasonable ranges for gauge fill (0–1 progress)
const RANGES = {
  temp:     { min: -10,   max: 50    },
  humidity: { min: 0,     max: 100   },
  light:    { min: 0,     max: 2000  },
  pressure: { min: 960,   max: 1060  },
  ozone:    { min: 0,     max: 100   },
  height:   { min: -50,   max: 500   },
};

const GRID  = 'rgba(255,255,255,0.04)';
const TICK  = 'rgba(180,178,172,0.45)';

// ── State ──────────────────────────────────────────────────────────────────
const history = {
  labels:   [],
  temp:     [], humidity: [], light: [],
  pressure: [], ozone:    [], height: [],
};

const stats = {};
SENSORS.forEach(k => { stats[k] = { min: Infinity, max: -Infinity, prev: null, current: null }; });

let pollingTimer = null;
let arduinoIP    = '192.168.1.100';

// ── Helpers ────────────────────────────────────────────────────────────────
const maxPts = () => parseInt(document.getElementById('window-select').value, 10);

function addLog(msg, type = '') {
  const ul  = document.getElementById('log-list');
  const t   = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const li  = document.createElement('li');
  const cls = type === 'err' ? 'log-err' : type === 'ok' ? 'log-ok' : '';
  li.innerHTML = `<span class="log-t">${t}</span><span class="${cls}">${msg}</span>`;
  ul.prepend(li);
  while (ul.children.length > 60) ul.removeChild(ul.lastChild);
}

function clearLog() {
  document.getElementById('log-list').innerHTML = '';
  addLog('Log cleared.');
}
window.clearLog = clearLog;

function flash(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('flashing');
  void el.offsetWidth;
  el.classList.add('flashing');
  setTimeout(() => el.classList.remove('flashing'), 900);
}

// ── Mini arc gauge (drawn on panel-chart canvas background layer) ─────────
// Each panel-chart gets a thin arc at the top representing current value in range.
// We draw this onto a separate small canvas injected above the Chart.js canvas.

const gaugeCanvases = {};
const gaugeAnimState = {}; // current animated fill fraction per sensor

function initGauge(key, color) {
  const panelChart = document.getElementById(`chart-${key}`).parentElement;
  const gc = document.createElement('canvas');
  gc.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:52px;pointer-events:none;z-index:2;';
  panelChart.style.position = 'relative';
  panelChart.prepend(gc);
  gaugeCanvases[key] = gc;
  gaugeAnimState[key] = 0;
}

function drawGauge(key, fraction, color) {
  const gc  = gaugeCanvases[key];
  if (!gc) return;
  const W   = gc.offsetWidth || 200;
  const H   = 52;
  gc.width  = W;
  gc.height = H;
  const ctx = gc.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const margin = 20;
  const y      = H - 10;
  const startX = margin;
  const endX   = W - margin;
  const len    = endX - startX;

  // track line
  ctx.beginPath();
  ctx.moveTo(startX, y);
  ctx.lineTo(endX, y);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';
  ctx.stroke();

  if (fraction > 0) {
    // filled segment with glow
    const fillEnd = startX + len * Math.min(fraction, 1);
    const grad = ctx.createLinearGradient(startX, 0, fillEnd, 0);
    grad.addColorStop(0, color + '55');
    grad.addColorStop(1, color);
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(fillEnd, y);
    ctx.strokeStyle = grad;
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur  = 8;
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // cursor dot
    ctx.beginPath();
    ctx.arc(fillEnd, y, 3, 0, Math.PI * 2);
    ctx.fillStyle   = color;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 10;
    ctx.fill();
    ctx.shadowBlur  = 0;
  }
}

// Smooth animation toward target fraction
const gaugeTargets = {};
function animateGauges() {
  SENSORS.forEach(key => {
    const target = gaugeTargets[key] ?? 0;
    const cur    = gaugeAnimState[key] ?? 0;
    const delta  = target - cur;
    if (Math.abs(delta) > 0.001) {
      gaugeAnimState[key] = cur + delta * 0.12;
      drawGauge(key, gaugeAnimState[key], PALETTE[key]);
    }
  });
  requestAnimationFrame(animateGauges);
}

function updateGaugeTarget(key, value) {
  const r   = RANGES[key];
  const frac = (value - r.min) / (r.max - r.min);
  gaugeTargets[key] = Math.max(0, Math.min(1, frac));
}

// ── Chart factory ──────────────────────────────────────────────────────────
function makeChart(canvasId, color, dataKey) {
  const canvas = document.getElementById(canvasId);
  const ctx    = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, 160);
  gradient.addColorStop(0,    color + '50');
  gradient.addColorStop(0.45, color + '18');
  gradient.addColorStop(1,    color + '00');

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels:   history.labels,
      datasets: [{
        data:            history[dataKey],
        borderColor:     color,
        borderWidth:     1.5,
        pointRadius:     0,
        tension:         0.4,
        fill:            true,
        backgroundColor: gradient,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 350, easing: 'easeInOutQuart' },
      plugins: {
        legend:  { display: false },
        tooltip: { enabled: false },
      },
      layout: { padding: { top: 56 } }, // leave room for gauge
      scales: {
        x: {
          ticks:  { display: false },
          grid:   { color: GRID },
          border: { display: false },
        },
        y: {
          position: 'right',
          ticks: {
            color:         TICK,
            font:          { family: 'DM Mono', size: 8 },
            maxTicksLimit: 3,
            padding:       6,
          },
          grid:   { color: GRID },
          border: { display: false },
        },
      },
    },
  });
}

// Initialise gauges first, then charts
SENSORS.forEach(key => initGauge(key, PALETTE[key]));
animateGauges();

const charts = {};
SENSORS.forEach(key => {
  charts[key] = makeChart(`chart-${key}`, PALETTE[key], key);
});

// ── Sensor update ──────────────────────────────────────────────────────────
function updateSensor(key, raw) {
  const v   = (raw !== null && raw !== undefined && !isNaN(raw)) ? Number(raw) : null;
  const dec = key === 'ozone' ? 2 : key === 'light' ? 0 : 1;
  const el  = document.getElementById(`val-${key}`);
  if (!el) return;

  const display = v !== null ? v.toFixed(dec) : '—';
  if (el.textContent !== display) {
    el.textContent = display;
    flash(`val-${key}`);
  }

  if (v === null) return;

  updateGaugeTarget(key, v);
  stats[key].current = v;

  const st = stats[key];
  if (v < st.min) st.min = v;
  if (v > st.max) st.max = v;

  document.getElementById(`minmax-${key}`).textContent =
    `min ${st.min.toFixed(dec)} / max ${st.max.toFixed(dec)}`;

  const trendEl = document.getElementById(`trend-${key}`);
  if (st.prev !== null) {
    const delta = v - st.prev;
    if (Math.abs(delta) < 0.05) {
      trendEl.className   = 'trend';
      trendEl.textContent = '→';
    } else if (delta > 0) {
      trendEl.className   = 'trend up';
      trendEl.textContent = `↑ +${delta.toFixed(dec)}`;
    } else {
      trendEl.className   = 'trend down';
      trendEl.textContent = `↓ ${delta.toFixed(dec)}`;
    }
  }
  st.prev = v;
}

// ── Data ingestion ─────────────────────────────────────────────────────────
function applyData(d) {
  const readings = {
    temp:     d.temperature ?? d.temp     ?? null,
    humidity: d.humidity                  ?? null,
    light:    d.light                     ?? null,
    pressure: d.pressure                  ?? null,
    ozone:    d.ozone                     ?? null,
    height:   d.height      ?? d.altitude ?? null,
  };

  SENSORS.forEach(key => updateSensor(key, readings[key]));

  const label = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  history.labels.push(label);
  SENSORS.forEach(key => history[key].push(readings[key]));

  const limit = maxPts();
  if (history.labels.length > limit) {
    history.labels.shift();
    SENSORS.forEach(key => history[key].shift());
  }

  Object.values(charts).forEach(c => c.update());

  document.getElementById('last-update').textContent =
    `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

// ── Polling ────────────────────────────────────────────────────────────────
async function poll() {
  const pill        = document.getElementById('status-pill');
  const pillText    = pill.querySelector('.status-text');
  const errorBanner = document.getElementById('error-banner');
  const errorMsg    = document.getElementById('error-msg');

  try {
    const res = await fetch(`http://${arduinoIP}/data`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    pill.className      = 'status-pill live';
    pillText.textContent = 'Live';
    errorBanner.classList.remove('show');
    applyData(data);
  } catch (err) {
    pill.className      = 'status-pill';
    pillText.textContent = 'Offline';
    errorMsg.textContent = `Cannot reach http://${arduinoIP}/data — ${err.message}`;
    errorBanner.classList.add('show');
    addLog(err.message, 'err');
  }
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  const ms = parseInt(document.getElementById('refresh-select').value, 10);
  poll();
  pollingTimer = setInterval(poll, ms);
  addLog(`Polling http://${arduinoIP}/data every ${ms / 1000}s`, 'ok');
}

// ── Events ─────────────────────────────────────────────────────────────────
document.getElementById('connect-btn').addEventListener('click', () => {
  arduinoIP = document.getElementById('ip-input').value.trim() || '192.168.1.100';
  addLog(`Connecting to ${arduinoIP}…`);
  startPolling();
});

document.getElementById('refresh-select').addEventListener('change', () => {
  if (pollingTimer) startPolling();
});

// ── Clock ───────────────────────────────────────────────────────────────────
function tick() {
  const now = new Date();
  document.getElementById('hdr-date').textContent =
    now.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase();
  document.getElementById('footer-time').textContent = now.toLocaleString();
}
tick();
setInterval(tick, 1000);
