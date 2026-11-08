import { Hidpp, LOGITECH } from './hidpp.js';
import { readProfiles, readSector, writeSector, writeTextMacro, validSector } from './onboard.js';

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

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function controls() {
  $('connect').disabled = busy || !navigator.hid;
  $('connect').hidden = !!client;
  $('disconnect').hidden = !client;
  $('disconnect').disabled = busy;
  $('dpi').disabled = busy || !dpi;
  $('apply-dpi').disabled = busy || !dpi;
  $('rate').disabled = busy || !rate;
  $('apply-rate').disabled = busy || !rate;
  $('lod').disabled = busy || !dpi?.lodSupported;
  $('apply-lod').disabled = busy || !dpi?.lodSupported;
  for (const button of document.querySelectorAll('#advanced button')) button.disabled = busy;
  $('mode').disabled = busy || !mode;
  $('apply-mode').disabled = busy || !mode;
  $('profile-select').disabled = busy;
}

function renderDpi() {
  $('dpi').value = dpi?.current ?? '';
  $('dpi').min = dpi?.min ?? '';
  $('dpi').max = dpi?.max ?? '';
  $('dpi-range').textContent = dpi ? `${dpi.min.toLocaleString('ru-RU')}–${dpi.max.toLocaleString('ru-RU')} DPI` : '—';
  $('dpi-current').textContent = dpi ? `Текущее значение: ${dpi.current.toLocaleString('ru-RU')} DPI` : 'Регулировка DPI не найдена у этого устройства.';
  $('lod-control').hidden = !dpi?.lodSupported;
  if (dpi?.lodSupported) $('lod').value = String(dpi.lod);
}

function renderRate() {
  $('rate').replaceChildren();
  if (!rate) $('rate').add(new Option('Нет данных', ''));
  else for (const hz of [...rate.rates].sort((a, b) => b - a)) $('rate').add(new Option(`${hz} Гц`, String(hz), hz === rate.current, hz === rate.current));
  $('rate-current').textContent = rate ? `Текущее значение: ${rate.current} Гц` : 'Регулировка частоты опроса не найдена у этого устройства.';
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
  $('lod-control').hidden = true;
  $('dpi-current').textContent = 'Подключите устройство, чтобы узнать текущее значение.';
  $('rate').replaceChildren(new Option('Нет данных', ''));
  $('rate-current').textContent = 'Доступные значения зависят от модели и подключения.';
  $('advanced').hidden = true;
  $('lighting-controls').hidden = true;
  $('profile-controls').hidden = true;
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
    try { mode = await candidate.readMode(); } catch (error) { errors.push(`Режим: ${error.message}`); }
    try {
      const battery = await candidate.readBattery();
      $('battery').textContent = battery ? `Батарея: ${battery.approximate ? '≈' : ''}${battery.percent}%${battery.charging ? ' · зарядка' : ''}` : '';
    } catch { $('battery').textContent = ''; }
    renderMode();
    $('advanced').hidden = false;
    renderDpi(); renderRate();
    message(errors.length ? errors.join(' · ') : 'Настройки прочитаны. Некоторые устройства разрешают изменение только в режиме хоста.', errors.length > 0);
  } catch (error) {
    await candidate.close().catch(() => {});
    message(`Не удалось подключиться: ${error.message}`, true);
  } finally { busy = false; controls(); }
});

$('disconnect').addEventListener('click', async () => { await reset(); message('Устройство отключено.'); });
$('apply-dpi').addEventListener('click', async () => {
  const value = Number($('dpi').value);
  if (!Number.isFinite(value) || !$('dpi').value || value < dpi.min || value > dpi.max) { message('Введите DPI в указанном диапазоне.', true); return; }
  busy = true; controls();
  try { dpi = await client.setDpi(dpi, value); renderDpi(); message(`Текущий DPI: ${dpi.current}.`); }
  catch (error) { message(`Не удалось изменить DPI: ${error.message}. Проверьте режим памяти устройства.`, true); }
  finally { busy = false; controls(); }
});
$('apply-rate').addEventListener('click', async () => {
  busy = true; controls();
  try { rate = await client.setRate(rate, Number($('rate').value)); renderRate(); message(`Текущая частота: ${rate.current} Гц.`); }
  catch (error) { message(`Не удалось изменить частоту: ${error.message}. Проверьте режим памяти устройства.`, true); }
  finally { busy = false; controls(); }
});
$('apply-lod').addEventListener('click', async () => {
  busy = true; controls();
  try { dpi = await client.setLod(dpi, Number($('lod').value)); renderDpi(); message('Высота отрыва прочитана после изменения.'); }
  catch (error) { message(`Не удалось изменить высоту отрыва: ${error.message}`, true); }
  finally { busy = false; controls(); }
});

if (!navigator.hid) $('browser-notice').hidden = false;
else navigator.hid.addEventListener('disconnect', event => {
  if (client?.device === event.device) reset().then(() => message('Устройство отключено.'));
});
controls();

function renderMode() {
  $('mode').replaceChildren();
  if (!mode) $('mode').add(new Option('Не поддерживается', ''));
  else {
    $('mode').add(new Option('Память устройства', '1', mode.value === 1, mode.value === 1));
    $('mode').add(new Option('Режим хоста', '2', mode.value === 2, mode.value === 2));
  }
}

async function operation(action) {
  if (!client || busy) return;
  busy = true; controls();
  try { await action(); }
  catch (error) { message(error.message || String(error), true); }
  finally { busy = false; controls(); }
}

$('apply-mode').addEventListener('click', () => operation(async () => {
  mode = await client.setMode(mode, Number($('mode').value));
  renderMode();
  message('Режим устройства обновлён.');
}));

const effectNames = new Map([[0, 'Выключено'], [1, 'Постоянный цвет'], [3, 'Смена цветов'], [10, 'Дыхание']]);
function renderEffects() {
  $('effect').replaceChildren();
  const zone = lighting?.zones.find(z => z.index === Number($('zone').value));
  for (const effect of zone?.effects ?? []) if (effectNames.has(effect)) $('effect').add(new Option(effectNames.get(effect), String(effect)));
  $('apply-light').disabled = busy || !$('effect').options.length;
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
  await client.setLighting(lighting, Number($('zone').value), Number($('effect').value), $('color').value, Number($('period').value), Number($('brightness').value), $('persist-light').checked);
  message('Команда подсветки отправлена. Если эффект не изменился, проверьте режим хоста и сохранение в памяти.');
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
$('load-profiles').addEventListener('click', () => operation(async () => {
  profiles = await readProfiles(client);
  if (!profiles?.entries.length) throw new Error('Встроенные профили не найдены');
  $('profile-select').replaceChildren();
  for (const entry of profiles.entries.filter(e => e.enabled)) $('profile-select').add(new Option(`Профиль ${entry.sector}${entry.sector === profiles.current ? ' · активный' : ''}`, String(entry.sector), entry.sector === profiles.current, entry.sector === profiles.current));
  if (!$('profile-select').options.length) throw new Error('Активные профили не найдены');
  await openProfile(); message('Встроенный профиль прочитан.');
}));
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
$('key-capture').addEventListener('keydown', event => {
  event.preventDefault();
  const code = event.code;
  let usage = /^Key[A-Z]$/.test(code) ? code.charCodeAt(3) - 65 + 4 : /^Digit[1-9]$/.test(code) ? Number(code.slice(5)) + 0x1d : code === 'Digit0' ? 0x27 : /^F([1-9]|1[0-2])$/.test(code) ? Number(code.slice(1)) + 0x39 : ({ Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39, ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52 })[code];
  if (usage === undefined) { capturedKey = null; $('key-capture').value = 'Неподдерживаемая клавиша'; return; }
  const modifiers = (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
  capturedKey = [0x80, 2, modifiers, usage];
  $('key-capture').value = [event.ctrlKey && 'Ctrl', event.shiftKey && 'Shift', event.altKey && 'Alt', event.metaKey && 'Win', event.key.length === 1 ? event.key.toUpperCase() : event.key].filter(Boolean).join(' + ');
});
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
