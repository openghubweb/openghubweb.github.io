import { Hidpp, LOGITECH } from './hidpp.js';
import { readProfiles, readSector, writeSector, writeTextMacro, writeMacro, encodeSteps, validSector, profileDpi, profileRate } from './onboard.js';

const $ = id => document.getElementById(id);
let client = null;
let dpi = null;
let rate = null;
let busy = false;
let mode = null;
let lighting = null;
let profiles = null;
let profileBytes = null;
let profileSector = null;
let activeTab = 'sensitivity';

function renderTab() {
  for (const tab of document.querySelectorAll('.tab')) {
    const selected = tab.dataset.tab === activeTab;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $('sensitivity-panel').hidden = activeTab !== 'sensitivity';
  $('device-panel').hidden = activeTab !== 'device';
  $('lighting-panel').hidden = activeTab !== 'lighting';
  $('profiles-panel').hidden = !['sensitivity', 'buttons', 'macros'].includes(activeTab);
  for (const panel of document.querySelectorAll('[data-profile-tab]')) panel.hidden = panel.dataset.profileTab !== activeTab;
  $('tab-connect').hidden = !!client || activeTab === 'sensitivity';
}
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => { activeTab = tab.dataset.tab; renderTab(); });
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('.tab')], index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next].click(); tabs[next].focus();
  });
}
renderTab();

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function controls() {
  $('connect').disabled = busy || !navigator.hid;
  $('connect').hidden = !!client;
  $('disconnect').hidden = !client;
  $('disconnect').disabled = busy;
  const writable = mode?.value === 1 && profiles?.format === 4 && profiles?.size === 255 && !!profileBytes && profileSector === Number($('profile-select').value);
  $('dpi').disabled = busy || !dpi || !writable;
  $('apply-dpi').disabled = busy || !dpi || !writable;
  $('rate').disabled = busy || !rate || !writable;
  $('apply-rate').disabled = busy || !rate || !writable;
  for (const button of document.querySelectorAll('#advanced button:not(#macro-steps button)')) button.disabled = busy;
  for (const button of document.querySelectorAll('#macro-steps button')) button.disabled = busy || button.dataset.boundary === 'true';
  for (const id of ['save-stages', 'save-buttons', 'save-key', 'restore-profile', 'save-macro', 'save-steps']) $(id).disabled = busy || !writable;
  $('apply-light').disabled = busy || mode?.value !== 1 || !lighting || !$('effect').options.length;
  $('apply-mode').disabled = busy || !client || mode?.value === 1;
  $('profile-select').disabled = busy;
}

function renderDpi() {
  const index = profileBytes?.[1];
  const saved = index <= 4 ? profileBytes[3 + index * 2] | (profileBytes[4 + index * 2] << 8) : null;
  $('dpi').value = saved ?? '';
  $('dpi').min = dpi?.min ?? '';
  $('dpi').max = dpi?.max ?? '';
  $('dpi-range').textContent = dpi ? `${dpi.min.toLocaleString('ru-RU')}–${dpi.max.toLocaleString('ru-RU')} DPI` : '—';
  $('dpi-current').textContent = saved ? `Основная ступень выбранного профиля: ${saved.toLocaleString('ru-RU')} DPI` : 'Прочитайте профиль, чтобы изменить сохранённый DPI.';
}

function renderRate() {
  $('rate').replaceChildren();
  if (!rate) $('rate').add(new Option('Нет данных', ''));
  else for (const hz of [...rate.rates].filter(hz => { const p = Math.round(1000 / hz); return p >= 1 && p <= 8 && Math.floor(1000 / p) === hz; }).sort((a, b) => b - a)) $('rate').add(new Option(`${hz} Гц`, String(hz), hz === Math.floor(1000 / profileBytes?.[0]), hz === Math.floor(1000 / profileBytes?.[0])));
  $('rate-current').textContent = profileBytes?.[0] ? `В выбранном профиле: ${Math.floor(1000 / profileBytes[0])} Гц` : 'Прочитайте профиль, чтобы изменить сохранённую частоту.';
}

async function reset() {
  const old = client;
  client = null; dpi = null; rate = null; mode = null; lighting = null; profiles = null; profileBytes = null; profileSector = null;
  if (old) await old.close().catch(() => {});
  $('status').textContent = 'Не подключено';
  $('status-dot').classList.remove('online');
  $('device-heading').textContent = 'Мышь не выбрана';
  $('device-detail').textContent = 'Подключите мышь или её приёмник к компьютеру.';
  $('dpi').value = '';
  $('dpi-range').textContent = '—';
  $('dpi-current').textContent = 'Подключите устройство, чтобы узнать текущее значение.';
  $('rate').replaceChildren(new Option('Нет данных', ''));
  $('rate-current').textContent = 'Доступные значения зависят от модели и подключения.';
  $('advanced').hidden = true;
  $('lighting-controls').hidden = true;
  $('profile-controls').hidden = true;
  renderTab();
  controls();
}

$('connect').addEventListener('click', async () => {
  // requestDevice must be called directly from the user's click.
  let selected;
  try { selected = await navigator.hid.requestDevice({ filters: [{ vendorId: LOGITECH, usagePage: 0xff00 }] }); }
  catch (error) { message(`Не удалось открыть выбор устройства: ${error.message}`, true); return; }
  if (!selected.length) return;
  busy = true; controls(); message('Подключаемся и читаем настройки…');
  const candidate = new Hidpp(selected[0]);
  try {
    await candidate.connect();
    client = candidate;
    $('device-heading').textContent = selected[0].productName || 'Logitech HID++';
    $('device-detail').textContent = candidate.index === 0xff ? 'Подключено напрямую' : `Подключено через приёмник · слот ${candidate.index}`;
    $('status').textContent = 'Подключено'; $('status-dot').classList.add('online');
    const errors = [];
    try { dpi = await candidate.readDpi(); } catch (error) { errors.push(`DPI: ${error.message}`); }
    try { rate = await candidate.readRate(); } catch (error) { errors.push(`Частота: ${error.message}`); }
    try { mode = await candidate.enableOnboard(); } catch (error) { mode = null; errors.push(`Память устройства: ${error.message}`); }
    try {
      const battery = await candidate.readBattery();
      $('battery').textContent = battery ? `Батарея: ${battery.approximate ? '≈' : ''}${battery.percent}%${battery.charging ? ' · зарядка' : ''}` : '';
    } catch { $('battery').textContent = ''; }
    renderMode();
    $('advanced').hidden = false;
    renderTab();
    if (mode?.value === 1) try { await loadProfiles(); } catch (error) { errors.push(`Профили: ${error.message}`); }
    renderDpi(); renderRate();
    message(errors.length ? errors.join(' · ') : 'Включена память устройства. Профиль прочитан.', errors.length > 0);
  } catch (error) {
    await candidate.close().catch(() => {});
    message(`Не удалось подключиться: ${error.message}`, true);
  } finally { busy = false; controls(); }
});

$('disconnect').addEventListener('click', async () => { await reset(); message('Устройство отключено.'); });
$('apply-dpi').addEventListener('click', async () => {
  const value = Number($('dpi').value);
  await operation(async () => { requireProfile(); profileBytes = await writeSector(client, profiles, profileSector, profileBytes, profileDpi(profileBytes, value, dpi.values)); renderProfile(); message(`DPI ${value} записан в профиль.`); });
});
$('apply-rate').addEventListener('click', async () => {
  await operation(async () => { requireProfile(); const hz = Number($('rate').value); profileBytes = await writeSector(client, profiles, profileSector, profileBytes, profileRate(profileBytes, hz, rate.rates)); renderProfile(); message(`${hz} Гц записано в профиль.`); });
});

if (!navigator.hid) $('browser-notice').hidden = false;
else navigator.hid.addEventListener('disconnect', event => {
  if (client?.device === event.device) reset().then(() => message('Устройство отключено.'));
});
controls();

function renderMode() {
  $('mode-status').textContent = mode?.value === 1 ? 'Встроенная память включена' : 'Встроенная память не включена';
}

function requireProfile() {
  if (mode?.value !== 1 || !profileBytes || profileSector !== Number($('profile-select').value)) throw new Error('Включите память устройства и прочитайте профиль');
}

async function operation(action) {
  if (!client || busy) return;
  busy = true; controls();
  try { await action(); }
  catch (error) { message(error.message || String(error), true); }
  finally { busy = false; controls(); }
}

$('apply-mode').addEventListener('click', () => operation(async () => {
  mode = await client.enableOnboard();
  renderMode();
  await loadProfiles();
  message('Встроенная память включена, профиль прочитан.');
}));

const effectNames = new Map([[0, 'Выключено'], [1, 'Постоянный цвет'], [3, 'Смена цветов'], [10, 'Дыхание']]);
function renderEffects() {
  $('effect').replaceChildren();
  const zone = lighting?.zones.find(z => z.index === Number($('zone').value));
  for (const effect of zone?.effects ?? []) if (effectNames.has(effect)) $('effect').add(new Option(effectNames.get(effect), String(effect)));
  $('apply-light').disabled = busy || mode?.value !== 1 || !$('effect').options.length;
}
$('zone').addEventListener('change', renderEffects);
$('load-lighting').addEventListener('click', () => operation(async () => {
  lighting = await client.readLighting();
  if (!lighting?.zones.length) throw new Error('Зоны подсветки не обнаружены');
  $('zone').replaceChildren();
  const names = { 1: 'Основная', 2: 'Логотип', 3: 'Левая', 4: 'Правая', 5: 'Общая' };
  for (const zone of lighting.zones) $('zone').add(new Option(names[zone.location] || `Зона ${zone.index + 1}`, String(zone.index)));
  $('lighting-controls').hidden = false;
  renderEffects();
  message('Зоны и эффекты прочитаны с устройства.');
}));
$('apply-light').addEventListener('click', () => operation(async () => {
  if (!lighting || !$('effect').value) throw new Error('Выберите поддерживаемый эффект');
  if (mode?.value !== 1) throw new Error('Включите встроенную память устройства');
  await client.setLighting(lighting, Number($('zone').value), Number($('effect').value), $('color').value, Number($('period').value), Number($('brightness').value), true);
  message('Команда сохранения подсветки отправлена. Сохранение зависит от устройства.');
}));

const buttonNames = ['Левая', 'Правая', 'Средняя', 'Назад', 'Вперёд', 'DPI'];
const buttonOptions = [
  ['80010001', 'Левая кнопка'], ['80010002', 'Правая кнопка'], ['80010004', 'Средняя кнопка'],
  ['80010008', 'Назад'], ['80010010', 'Вперёд'], ['9003ff00', 'DPI выше'],
  ['9004ff00', 'DPI ниже'], ['9005ff00', 'Следующий DPI'], ['9006ff00', 'DPI по умолчанию'],
  ['9007ff00', 'DPI Shift'], ['900aff00', 'Следующий профиль'], ['900bff00', 'G-Shift'],
  ['80020106', 'Ctrl + C'], ['80020119', 'Ctrl + V'], ['8002011b', 'Ctrl + X'], ['ffffffff', 'Отключено'],
  ['800300e2', 'Без звука'], ['800300e9', 'Громкость выше'], ['800300ea', 'Громкость ниже'],
  ['800300cd', 'Воспроизведение / пауза'], ['800300b5', 'Следующий трек'], ['800300b6', 'Предыдущий трек'],
];
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function renderProfile() {
  renderDpi(); renderRate();
  $('stages').replaceChildren();
  $('default-stage').replaceChildren();
  $('shift-stage').replaceChildren();
  for (let i = 0; i < 5; i++) {
    const label = document.createElement('label');
    label.textContent = `Ступень ${i + 1}${profileBytes[1] === i ? ' · основная' : ''}`;
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.max = '65535'; input.value = String(profileBytes[3 + i * 2] | (profileBytes[4 + i * 2] << 8));
    input.setAttribute('aria-label', `DPI ступень ${i + 1}`);
    label.append(input); $('stages').append(label);
    $('default-stage').add(new Option(`Ступень ${i + 1}`, String(i), profileBytes[1] === i, profileBytes[1] === i));
    $('shift-stage').add(new Option(`Ступень ${i + 1}`, String(i), profileBytes[2] === i, profileBytes[2] === i));
  }
  $('buttons').replaceChildren();
  $('macro-button').replaceChildren();
  $('key-button').replaceChildren();
  for (let i = 0; i < profiles.buttons; i++) {
    const row = document.createElement('label'); row.className = 'button-row';
    const text = document.createElement('span'); text.textContent = buttonNames[i] || `Кнопка ${i + 1}`;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Назначение кнопки ${i + 1}`);
    const value = hex(profileBytes.slice(32 + i * 4, 36 + i * 4));
    if (!buttonOptions.some(([key]) => key === value)) select.add(new Option(`Текущее назначение (${value})`, value));
    for (const [key, name] of buttonOptions) select.add(new Option(name, key, key === value, key === value));
    row.append(text, select); $('buttons').append(row);
    $('macro-button').add(new Option(buttonNames[i] || `Кнопка ${i + 1}`, String(i)));
    $('key-button').add(new Option(buttonNames[i] || `Кнопка ${i + 1}`, String(i)));
  }
  $('profile-note').textContent = `Профиль ${profileSector}${profiles.current === profileSector ? ' · активный' : ''}. Формат памяти: ${profiles.format}.`;
  $('profile-controls').hidden = false;
}

async function openProfile() {
  const sector = Number($('profile-select').value);
  profileBytes = null;
  profileSector = null;
  const bytes = await readSector(client, profiles, sector);
  if (bytes.length < 32 + profiles.buttons * 4 + 2) throw new Error('Профиль слишком мал для таблицы кнопок');
  profileBytes = bytes;
  profileSector = sector;
  renderProfile();
}
async function loadProfiles() {
  profiles = await readProfiles(client);
  if (!profiles?.entries.length) throw new Error('Встроенные профили не найдены');
  $('profile-select').replaceChildren();
  for (const entry of profiles.entries.filter(e => e.enabled)) $('profile-select').add(new Option(`Профиль ${entry.sector}${entry.sector === profiles.current ? ' · активный' : ''}`, String(entry.sector), entry.sector === profiles.current, entry.sector === profiles.current));
  if (!$('profile-select').options.length) throw new Error('Активные профили не найдены');
  await openProfile();
}
$('load-profiles').addEventListener('click', () => operation(async () => { await loadProfiles(); message('Встроенный профиль прочитан.'); }));
$('read-profile').addEventListener('click', () => operation(openProfile));
$('profile-select').addEventListener('change', () => operation(openProfile));
$('save-stages').addEventListener('click', () => operation(async () => {
  if (!profileBytes || profileSector !== Number($('profile-select').value)) throw new Error('Прочитайте профиль заново');
  if (!dpi) throw new Error('Не удалось определить допустимый диапазон DPI');
  const values = [...$('stages').querySelectorAll('input')].map(el => Number(el.value));
  if (values.some(v => !Number.isInteger(v) || v < 0 || v > 65535 || (v && !dpi.values.includes(v)))) throw new Error('Одна из ступеней DPI не поддерживается устройством');
  const defaultStage = Number($('default-stage').value), shiftStage = Number($('shift-stage').value);
  if (!values[defaultStage] || !values[shiftStage]) throw new Error('Основная и Shift-ступень должны быть ненулевыми');
  const changed = Uint8Array.from(profileBytes);
  changed[1] = defaultStage; changed[2] = shiftStage;
  values.forEach((value, i) => { changed[3 + i * 2] = value & 255; changed[4 + i * 2] = value >> 8; });
  profileBytes = await writeSector(client, profiles, profileSector, profileBytes, changed);
  renderProfile(); message('Ступени DPI записаны и проверены.');
}));
$('save-buttons').addEventListener('click', () => operation(async () => {
  if (!profileBytes || profileSector !== Number($('profile-select').value)) throw new Error('Прочитайте профиль заново');
  const changed = Uint8Array.from(profileBytes);
  [...$('buttons').querySelectorAll('select')].forEach((select, i) => {
    const bytes = select.value.match(/../g).map(value => parseInt(value, 16));
    changed.set(bytes, 32 + i * 4);
  });
  const hasLeft = Array.from({ length: profiles.buttons }, (_, i) => hex(changed.slice(32 + i * 4, 36 + i * 4))).includes('80010001');
  if (!hasLeft) throw new Error('Оставьте левое нажатие хотя бы на одной кнопке');
  profileBytes = await writeSector(client, profiles, profileSector, profileBytes, changed);
  renderProfile(); message('Назначения записаны и проверены.');
}));
let capturedKey = null;
function captureKey(event) {
  event.preventDefault();
  const code = event.code;
  let usage = /^Key[A-Z]$/.test(code) ? code.charCodeAt(3) - 65 + 4 : /^Digit[1-9]$/.test(code) ? Number(code.slice(5)) + 0x1d : code === 'Digit0' ? 0x27 : /^F([1-9]|1[0-2])$/.test(code) ? Number(code.slice(1)) + 0x39 : ({ Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39, ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52 })[code];
  if (usage === undefined) { event.target.value = 'Неподдерживаемая клавиша'; return null; }
  const modifiers = (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
  const label = [event.ctrlKey && 'Ctrl', event.shiftKey && 'Shift', event.altKey && 'Alt', event.metaKey && 'Win', event.key.length === 1 ? event.key.toUpperCase() : event.key].filter(Boolean).join(' + ');
  event.target.value = label;
  return { usage, modifiers, label };
}
$('key-capture').addEventListener('keydown', event => { const key = captureKey(event); capturedKey = key ? [0x80, 2, key.modifiers, key.usage] : null; });
$('save-key').addEventListener('click', () => operation(async () => {
  if (!profileBytes || profileSector !== Number($('profile-select').value) || !capturedKey) throw new Error('Прочитайте профиль и нажмите поддерживаемое сочетание');
  const changed = Uint8Array.from(profileBytes);
  changed.set(capturedKey, 32 + Number($('key-button').value) * 4);
  const hasLeft = Array.from({ length: profiles.buttons }, (_, i) => hex(changed.slice(32 + i * 4, 36 + i * 4))).includes('80010001');
  if (!hasLeft) throw new Error('Оставьте левое нажатие хотя бы на одной кнопке');
  profileBytes = await writeSector(client, profiles, profileSector, profileBytes, changed);
  renderProfile(); message('Сочетание записано и проверено.');
}));
$('restore-profile').addEventListener('click', () => operation(async () => {
  if (!profileBytes || profileSector !== Number($('profile-select').value)) throw new Error('Прочитайте профиль заново');
  const saved = localStorage.getItem(`openghub-backup-${client.device.productId}-${profileSector}-${client.session}`);
  if (!saved) throw new Error('Резервная копия этого профиля не найдена в браузере');
  const backup = JSON.parse(saved);
  const original = Uint8Array.from(backup.bytes);
  if (backup.productId !== client.device.productId || backup.sector !== profileSector || !validSector(original)) throw new Error('Резервная копия не соответствует устройству');
  profileBytes = await writeSector(client, profiles, profileSector, profileBytes, original);
  renderProfile(); message('Исходный профиль восстановлен и проверен.');
}));
$('save-macro').addEventListener('click', () => operation(async () => {
  if (!profileBytes || profileSector !== Number($('profile-select').value)) throw new Error('Прочитайте профиль заново');
  profileBytes = await writeTextMacro(client, profiles, profileSector, profileBytes, Number($('macro-button').value), $('macro-text').value, Number($('macro-delay').value));
  renderProfile(); message('Макрос записан и проверен.');
}));

let macroKey = null;
const steps = [];
$('macro-key').addEventListener('keydown', event => { macroKey = captureKey(event); });
function renderSteps() {
  $('macro-steps').replaceChildren();
  $('steps-empty').hidden = steps.length > 0;
  steps.forEach((step, index) => {
    const row = document.createElement('li');
    const label = document.createElement('span'); label.textContent = step.label;
    row.append(label);
    for (const [symbol, description, action, disabled] of [
      ['↑', 'Переместить выше', () => { [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]]; }, index === 0],
      ['↓', 'Переместить ниже', () => { [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]]; }, index === steps.length - 1],
      ['×', 'Удалить', () => steps.splice(index, 1), false],
    ]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = symbol; button.setAttribute('aria-label', `${description}: ${step.label}`); button.dataset.boundary = String(disabled); button.disabled = disabled;
      button.addEventListener('click', () => { action(); renderSteps(); }); row.append(button);
    }
    $('macro-steps').append(row);
  });
}
$('add-key').addEventListener('click', () => { if (!macroKey) return message('Нажмите клавишу или сочетание в поле редактора.', true); steps.push({ type: 'key', ...macroKey }); renderSteps(); });
$('add-delay').addEventListener('click', () => { const ms = Number($('step-delay').value); if (!Number.isInteger(ms) || ms < 0 || ms > 5000 || !$('step-delay').value) return message('Укажите паузу от 0 до 5000 мс.', true); steps.push({ type: 'delay', ms, label: `Пауза ${ms} мс` }); renderSteps(); });
$('add-mouse').addEventListener('click', () => { const select = $('step-mouse'); steps.push({ type: 'mouse', mask: Number(select.value), label: `Клик: ${select.selectedOptions[0].textContent}` }); renderSteps(); });
$('save-steps').addEventListener('click', () => operation(async () => {
  if (!profileBytes || profileSector !== Number($('profile-select').value)) throw new Error('Прочитайте профиль заново');
  profileBytes = await writeMacro(client, profiles, profileSector, profileBytes, Number($('macro-button').value), encodeSteps(steps));
  renderProfile(); message('Макрос записан на кнопку и проверен.');
}));
