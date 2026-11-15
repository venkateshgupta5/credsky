'use strict';

const API_BASE_URL = 'https://api.weatherapi.com/v1/current.json';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CITY = 'Mumbai';

const POPULAR_CITIES = [
  'Mumbai',
  'Delhi',
  'Bengaluru',
  'Hyderabad',
  'Chennai',
  'Kolkata',
  'Pune',
  'Ahmedabad',
  'New York',
  'London',
];

const PERSONALITIES = {
  rainCheck: { title: 'Rain Check', description: 'Carry an umbrella before stepping out.' },
  sunAlert: { title: 'Sun Alert', description: 'Stay hydrated and avoid excessive sun exposure.' },
  freezeFrame: { title: 'Freeze Frame', description: 'Bone-chilling cold. Bundle up tight.' },
  breezyMode: { title: 'Breezy Mode', description: 'Expect strong winds. Dress accordingly.' },
  perfectDay: { title: 'Perfect Day', description: 'Great weather to step outside.' },
};

const THRESHOLDS = { veryHotC: 35, veryColdC: 12, windyKph: 35 };

const state = {
  hasData: false,
  activeCity: null,
  lastRequestedCity: null,
  requestSequence: 0,
  rawJsonText: '',
  formattedJsonText: '',
  activeTab: 'formatted',
};

const el = (id) => document.getElementById(id);

const dom = {
  searchForm: el('search-form'),
  cityInput: el('city-input'),
  searchError: el('search-error'),
  chips: el('city-chips'),
  liveStatus: el('live-status'),
  loadingPanel: el('loading-panel'),
  loadingText: el('loading-text'),
  errorPanel: el('error-panel'),
  errorTitle: el('error-title'),
  errorMessage: el('error-message'),
  retryBtn: el('retry-btn'),
  weatherCard: el('weather-card'),
  updatingPill: el('updating-pill'),
  cityName: el('city-name'),
  localTime: el('local-time'),
  tempC: el('temp-c'),
  weatherIcon: el('weather-icon'),
  conditionText: el('condition-text'),
  feelsLike: el('feels-like'),
  personalityTitle: el('personality-title'),
  personalityDesc: el('personality-desc'),
  humidity: el('humidity'),
  wind: el('wind'),
  uv: el('uv'),
  cloud: el('cloud'),
  visibility: el('visibility'),
  pressure: el('pressure'),
  windSpeed: el('wind-speed'),
  tempF: el('temp-f'),
  lastUpdated: el('last-updated'),
  jsonView: el('json-view'),
  copyBtn: el('copy-btn'),
  tabFormatted: el('tab-formatted'),
  tabRaw: el('tab-raw'),
};

function normalizeCity(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isNum(value) {
  if (value === null || value === undefined || value === '') return false;
  return !Number.isNaN(Number(value));
}

function isRainyCondition(conditionText) {
  const text = String(conditionText || '').toLowerCase();
  return /(rain|drizzle|thunder|shower|sleet|blowing snow)/.test(text);
}

function getWeatherPersonality(current) {
  const temperatureC = Number(current.temp_c);
  const windKph = Number(current.wind_kph);
  const conditionText = current.condition && current.condition.text;

  if (isRainyCondition(conditionText)) return PERSONALITIES.rainCheck;
  if (temperatureC >= THRESHOLDS.veryHotC) return PERSONALITIES.sunAlert;
  if (temperatureC <= THRESHOLDS.veryColdC) return PERSONALITIES.freezeFrame;
  if (windKph >= THRESHOLDS.windyKph) return PERSONALITIES.breezyMode;
  return PERSONALITIES.perfectDay;
}

function formatLocalTime(datetime) {
  const value = String(datetime || '');
  const parts = value.split(' ');
  if (parts.length !== 2) return value || '—';
  const datePart = parts[0].split('-').map(Number);
  const timePart = parts[1].split(':').map(Number);
  if (datePart.length !== 3 || timePart.length < 2) return value;
  const parsed = new Date(
    datePart[0], datePart[1] - 1, datePart[2], timePart[0], timePart[1]
  );
  if (Number.isNaN(parsed.getTime())) return value;
  return (
    parsed.toLocaleString('en-US', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }) + ' (local time)'
  );
}

function renderChips() {
  dom.chips.innerHTML = '';
  POPULAR_CITIES.forEach((city) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = city;
    button.dataset.city = city;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => searchCity(city));
    dom.chips.appendChild(button);
  });
}

function highlightChips(cityName) {
  const target = normalizeCity(cityName);
  dom.chips.querySelectorAll('.chip').forEach((chip) => {
    const isActive = target !== '' && normalizeCity(chip.dataset.city) === target;
    chip.classList.toggle('active', isActive);
    chip.setAttribute('aria-pressed', String(isActive));
  });
}

function announce(message) {
  dom.liveStatus.textContent = message;
}

function setLoading(isLoading, city) {
  if (isLoading) {
    dom.errorPanel.hidden = true;
    if (state.hasData) {
      dom.updatingPill.hidden = false;
      announce(`Updating weather for ${city}…`);
    } else {
      dom.loadingPanel.hidden = false;
      dom.weatherCard.hidden = true;
      dom.loadingText.textContent = `Fetching weather for ${city}…`;
      announce(`Fetching weather for ${city}…`);
    }
  } else {
    dom.updatingPill.hidden = true;
    dom.loadingPanel.hidden = true;
  }
}

function classifyHttpError(status, errorBody) {
  const code = errorBody && errorBody.error ? errorBody.error.code : undefined;
  if (code === 2008 || status === 429) return 'rate_limit';
  if (code === 2006 || code === 2007 || status === 401 || status === 403) return 'api_config';
  if (code === 1006 || status === 400) return 'not_found';
  if (status >= 500) return 'server';
  return 'generic';
}

const ERROR_CONTENT = {
  not_found: (city) => ({
    title: 'City not found',
    message: `We couldn't find "${city}". Please check the spelling or try another city.`,
  }),
  api_config: () => ({
    title: 'API configuration error',
    message: 'The weather service rejected the configured API key. Please verify the WeatherAPI key and try again.',
  }),
  rate_limit: () => ({
    title: 'Temporary service error',
    message: 'The weather service is rate limited right now. Please retry in a moment.',
  }),
  network: () => ({
    title: 'Network unavailable',
    message: 'We could not reach the weather service. Please check your internet connection and try again.',
  }),
  timeout: () => ({
    title: 'Request timed out',
    message: 'The weather service took too long to respond. Please try again.',
  }),
  server: () => ({
    title: 'Service unavailable',
    message: 'The weather service is temporarily unavailable. Please try again shortly.',
  }),
  generic: () => ({
    title: 'Something went wrong',
    message: 'We received an unexpected response from the weather service. Please try again.',
  }),
};

function showError(kind, city) {
  const content = (ERROR_CONTENT[kind] || ERROR_CONTENT.generic)(city);
  dom.errorTitle.textContent = content.title;
  dom.errorMessage.textContent = content.message;
  if (!state.hasData) dom.weatherCard.hidden = true;
  setLoading(false);
  dom.errorPanel.hidden = false;
  announce(`${content.title}. ${content.message}`);
}

function renderJsonView() {
  if (!state.hasData) {
    dom.jsonView.textContent = 'Search a city to view the live API response here.';
    return;
  }
  dom.jsonView.textContent =
    state.activeTab === 'formatted' ? state.formattedJsonText : state.rawJsonText;
}

function setActiveTab(tab) {
  state.activeTab = tab;
  dom.tabFormatted.classList.toggle('active', tab === 'formatted');
  dom.tabRaw.classList.toggle('active', tab === 'raw');
  dom.tabFormatted.setAttribute('aria-selected', String(tab === 'formatted'));
  dom.tabRaw.setAttribute('aria-selected', String(tab === 'raw'));
  renderJsonView();
}

async function copyJson() {
  const text = state.hasData
    ? state.activeTab === 'formatted' ? state.formattedJsonText : state.rawJsonText
    : '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    document.body.removeChild(helper);
  }
  dom.copyBtn.textContent = 'Copied!';
  setTimeout(() => {
    dom.copyBtn.textContent = 'Copy';
  }, 1600);
}

function renderWeather(data, rawText) {
  const location = data.location || {};
  const current = data.current || {};
  const condition = current.condition || {};

  state.hasData = true;
  state.activeCity = location.name || state.lastRequestedCity;
  state.rawJsonText = rawText;
  state.formattedJsonText = JSON.stringify(data, null, 2);

  dom.cityInput.value = state.activeCity;

  dom.cityName.textContent = state.activeCity;
  dom.localTime.textContent = formatLocalTime(location.localtime);

  dom.tempC.textContent = isNum(current.temp_c) ? Math.round(Number(current.temp_c)) : '—';
  if (condition.icon) {
    dom.weatherIcon.src = `https:${condition.icon}`;
    dom.weatherIcon.hidden = false;
    dom.weatherIcon.alt = condition.text || 'Weather icon';
  } else {
    dom.weatherIcon.hidden = true;
  }
  dom.conditionText.textContent = condition.text || '—';
  dom.feelsLike.textContent = isNum(current.feelslike_c)
    ? `Feels like ${Math.round(Number(current.feelslike_c))}°C`
    : 'Feels like —';

  const personality = getWeatherPersonality(current);
  dom.personalityTitle.textContent = personality.title;
  dom.personalityDesc.textContent = personality.description;

  dom.humidity.textContent = isNum(current.humidity) ? Number(current.humidity) : '—';
  dom.wind.textContent = isNum(current.wind_kph) ? Math.round(Number(current.wind_kph)) : '—';
  dom.uv.textContent = isNum(current.uv) ? Number(current.uv) : '—';

  dom.cloud.textContent = isNum(current.cloud) ? `${Number(current.cloud)}%` : '—';
  dom.visibility.textContent = isNum(current.vis_km) ? `${current.vis_km} km` : '—';
  dom.pressure.textContent = isNum(current.pressure_mb) ? `${current.pressure_mb} mb` : '—';
  dom.windSpeed.textContent = isNum(current.wind_kph) ? `${current.wind_kph} km/h` : '—';
  dom.tempF.textContent = isNum(current.temp_f) ? `${Math.round(Number(current.temp_f))}°F` : '—';
  dom.lastUpdated.textContent = formatLocalTime(current.last_updated);

  highlightChips(state.activeCity);

  setLoading(false);
  dom.errorPanel.hidden = true;
  dom.weatherCard.hidden = false;
  dom.copyBtn.disabled = false;
  renderJsonView();
  announce(`Weather updated for ${state.activeCity}.`);
}

async function fetchWeather(city) {
  const apiKey = window.APP_CONFIG && window.APP_CONFIG.weatherApiKey;
  if (!apiKey) {
    showError('api_config', city);
    return;
  }

  state.lastRequestedCity = city;
  const sequence = ++state.requestSequence;
  setLoading(true, city);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${API_BASE_URL}?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(city)}&aqi=no`;
    const response = await fetch(url, { signal: controller.signal });
    if (sequence !== state.requestSequence) return;

    const responseText = await response.text();
    if (sequence !== state.requestSequence) return;

    if (!response.ok) {
      let errorBody = null;
      try {
        errorBody = JSON.parse(responseText);
      } catch (_) {
        errorBody = null;
      }
      showError(classifyHttpError(response.status, errorBody), city);
      return;
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (_) {
      showError('generic', city);
      return;
    }
    renderWeather(data, responseText);
  } catch (error) {
    if (sequence !== state.requestSequence) return;
    if (error && error.name === 'AbortError') {
      showError('timeout', city);
    } else {
      showError('network', city);
    }
  } finally {
    clearTimeout(timer);
    if (sequence === state.requestSequence) {
      setLoading(false);
    }
  }
}

function searchCity(cityInput) {
  const city = String(cityInput == null ? dom.cityInput.value : cityInput).trim();
  if (!city) {
    dom.searchError.textContent = 'Please enter a city name.';
    dom.searchError.hidden = false;
    dom.cityInput.focus();
    return;
  }
  if (cityInput != null) dom.cityInput.value = city;
  dom.searchError.hidden = true;
  fetchWeather(city);
}

function init() {
  renderChips();
  dom.cityInput.value = DEFAULT_CITY;

  dom.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    searchCity();
  });

  dom.retryBtn.addEventListener('click', () => {
    if (state.lastRequestedCity) fetchWeather(state.lastRequestedCity);
  });

  dom.copyBtn.addEventListener('click', copyJson);
  dom.tabFormatted.addEventListener('click', () => setActiveTab('formatted'));
  dom.tabRaw.addEventListener('click', () => setActiveTab('raw'));

  renderJsonView();
  dom.copyBtn.disabled = true;

  searchCity(DEFAULT_CITY);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
