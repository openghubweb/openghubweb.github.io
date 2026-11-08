// G-series onboard profile format. Never overwrite unverified sectors.
export function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function validSector(bytes) {
  if (bytes.length < 16) return false;
  if (bytes.every(v => v === 255)) return true;
  return crc16(bytes.subarray(0, -2)) === ((bytes.at(-2) << 8) | bytes.at(-1));
}

export async function readSector(client, info, sector) {
  if (sector < 0 || sector >= info.sectors || info.size < 16 || info.size > 4096) throw new Error('Неверный адрес памяти устройства');
  const bytes = new Uint8Array(info.size);
  const offsets = [];
  for (let offset = 0; offset <= info.size - 16; offset += 16) offsets.push(offset);
  if (offsets.at(-1) !== info.size - 16) offsets.push(info.size - 16);
  for (const offset of offsets) {
    const reply = await client.call(info.feature, 5, [sector >> 8, sector & 255, offset >> 8, offset & 255]);
    if (reply.length < 16) throw new Error('Неполный ответ памяти устройства');
    bytes.set(reply.slice(0, 16), offset);
  }
  if (!validSector(bytes)) throw new Error(`Профиль ${sector} не прошёл проверку контрольной суммы`);
  return bytes;
}

export async function readProfiles(client) {
  const feature = await client.feature(0x8100);
  if (!feature) return null;
  const p = await client.call(feature, 0);
  const info = { feature, format: p[1], macros: p[2], profiles: p[3], buttons: p[5], sectors: p[6], size: (p[7] << 8) | p[8] };
  if (info.size < 16 || info.size > 4096 || !info.sectors || info.sectors > 128 || info.buttons > 16) throw new Error('Неизвестный формат памяти устройства');
  const directory = await readSector(client, info, 0);
  const entries = [];
  for (let i = 0; i + 3 < directory.length - 2 && entries.length < info.profiles; i += 4) {
    const sector = (directory[i] << 8) | directory[i + 1];
    if (sector === 0 || sector === 0xffff) break;
    if (sector >= info.sectors) throw new Error('Профиль указывает за пределы памяти устройства');
    entries.push({ sector, enabled: directory[i + 2] !== 0 });
  }
  const current = await client.call(feature, 4).catch(() => new Uint8Array(2));
  return { ...info, entries, current: (current[0] << 8) | current[1] };
}

export async function writeSector(client, info, sector, original, changed) {
  if (info.format !== 4 || info.size !== 255) throw new Error('Запись для этого формата памяти пока не поддерживается');
  if (!validSector(original) || original.length !== info.size || changed.length !== info.size) throw new Error('Невозможно проверить исходный профиль');
  const current = await readSector(client, info, sector);
  if (!current.every((byte, i) => byte === original[i])) throw new Error('Профиль изменился. Прочитайте его заново перед записью');
  const copy = Uint8Array.from(changed);
  const crc = crc16(copy.subarray(0, -2));
  copy[copy.length - 2] = crc >> 8;
  copy[copy.length - 1] = crc & 255;
  if (copy.every((b, i) => b === original[i])) return copy;
  // Keep the original sector locally before making any flash changes.
  const key = `openghub-backup-${client.device.productId}-${sector}-${client.session}`;
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ productId: client.device.productId, sector, bytes: Array.from(original) }));
  if (!localStorage.getItem(key)) throw new Error('Не удалось сохранить резервную копию профиля');
  await client.call(info.feature, 6, [sector >> 8, sector & 255, 0, 0, info.size >> 8, info.size & 255]);
  for (let offset = 0; offset < copy.length; offset += 16) {
    const chunk = new Uint8Array(16).fill(255);
    chunk.set(copy.slice(offset, offset + 16));
    await client.call(info.feature, 7, [...chunk]);
  }
  await client.call(info.feature, 8);
  const readback = await readSector(client, info, sector);
  if (!readback.every((byte, i) => byte === copy[i])) throw new Error('Устройство не подтвердило записанный профиль');
  return readback;
}

export function encodeTextMacro(text, delay) {
  if (!text || text.length > 40 || !Number.isInteger(delay) || delay < 0 || delay > 5000) throw new Error('Макрос должен содержать 1–40 символов и задержку от 0 до 5000 мс');
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let usage, shift = false;
    if (/[a-z]/.test(ch)) usage = ch.charCodeAt(0) - 97 + 4;
    else if (/[A-Z]/.test(ch)) { usage = ch.charCodeAt(0) - 65 + 4; shift = true; }
    else if (/[1-9]/.test(ch)) usage = ch.charCodeAt(0) - 49 + 0x1e;
    else usage = ({ '0': 0x27, ' ': 0x2c, '\n': 0x28, '\t': 0x2b, '-': 0x2d, '=': 0x2e, '.': 0x37, ',': 0x36, '/': 0x38, ';': 0x33, "'": 0x34 })[ch];
    if (usage === undefined) throw new Error(`Символ «${ch}» не поддерживается текстовым макросом`);
    if (i && delay) out.push(0x80, delay >> 8, delay & 255);
    if (shift) out.push(0x22, 2);
    out.push(0x20, usage, 0x21, usage);
    if (shift) out.push(0x23, 2);
  }
  out.push(255);
  return Uint8Array.from(out);
}

// Append to genuinely free bytes, preserving every macro referenced by any profile.
export async function writeMacro(client, info, sector, profile, button, bytes) {
  if (info.format !== 4 || info.macros !== 1 || info.size !== 255) throw new Error('Макросы для этого формата памяти пока не поддерживаются');
  if (!Number.isInteger(button) || button < 0 || button >= info.buttons) throw new Error('Неверная кнопка');
  if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.at(-1) !== 255) throw new Error('Макрос пуст или повреждён');
  const slot = info.entries.findIndex(e => e.sector === sector);
  const macroSector = info.sectors - 1 - slot;
  if (slot < 0 || macroSector <= 0 || info.entries.some(e => e.sector === macroSector)) throw new Error('Не удалось безопасно определить сектор макросов');
  const originalMacro = await readSector(client, info, macroSector);
  const reserved = new Uint8Array(info.size);
  for (const entry of info.entries) {
    const data = entry.sector === sector ? profile : await readSector(client, info, entry.sector);
    for (const base of [32, 96]) for (let i = 0; i < info.buttons; i++) {
      const pos = base + i * 4;
      if (pos + 3 >= data.length - 2) throw new Error('Некорректная таблица кнопок');
      if (data[pos] !== 0 || data[pos + 1] !== macroSector) continue;
      let cursor = (data[pos + 2] << 8) | data[pos + 3];
      let ended = false;
      while (cursor < info.size - 2) {
        const opcode = originalMacro[cursor];
        const length = opcode === 255 || opcode === 0 ? 1 : [0x20, 0x21, 0x22, 0x23].includes(opcode) ? 2 : [0x40, 0x41, 0x80].includes(opcode) ? 3 : 0;
        if (!length || cursor + length > info.size - 2) throw new Error('Существующий макрос не удалось проверить');
        reserved.fill(1, cursor, cursor + length);
        cursor += length;
        if (opcode === 255) { ended = true; break; }
      }
      if (!ended) throw new Error('Существующий макрос не имеет завершения');
    }
  }
  let offset = -1;
  for (let i = 0; i + bytes.length <= info.size - 2; i++) {
    if (bytes.every((_, j) => !reserved[i + j] && originalMacro[i + j] === 255)) { offset = i; break; }
  }
  if (offset < 0) throw new Error('В памяти устройства недостаточно свободного места для макроса');
  const changedProfile = Uint8Array.from(profile);
  changedProfile.set([0, macroSector, offset >> 8, offset & 255], 32 + button * 4);
  const hasPrimary = Array.from({ length: info.buttons }, (_, i) => changedProfile.slice(32 + i * 4, 36 + i * 4)).some(d => d[0] === 0x80 && d[1] === 1 && d[2] === 0 && d[3] === 1);
  if (!hasPrimary) throw new Error('Оставьте левое нажатие хотя бы на одной кнопке');
  const originalKey = `openghub-backup-${client.device.productId}-${sector}-${client.session}`;
  if (!localStorage.getItem(originalKey)) localStorage.setItem(originalKey, JSON.stringify({ productId: client.device.productId, sector, bytes: Array.from(profile) }));
  const changedMacro = Uint8Array.from(originalMacro);
  changedMacro.set(bytes, offset);
  await writeSector(client, info, macroSector, originalMacro, changedMacro);
  return writeSector(client, info, sector, profile, changedProfile);
}

export function writeTextMacro(client, info, sector, profile, button, text, delay) {
  return writeMacro(client, info, sector, profile, button, encodeTextMacro(text, delay));
}

export function encodeSteps(steps) {
  if (!steps.length) throw new Error('Добавьте хотя бы одно действие');
  const out = [];
  for (const step of steps) {
    if (step.type === 'key' && Number.isInteger(step.usage) && step.usage >= 4 && step.usage <= 0xff && Number.isInteger(step.modifiers) && step.modifiers >= 0 && step.modifiers <= 15) {
      if (step.modifiers) out.push(0x22, step.modifiers);
      out.push(0x20, step.usage, 0x21, step.usage);
      if (step.modifiers) out.push(0x23, step.modifiers);
    } else if (step.type === 'mouse' && [1, 2, 4, 8, 16].includes(step.mask)) {
      out.push(0x40, 0, step.mask, 0x41, 0, step.mask);
    } else if (step.type === 'delay' && Number.isInteger(step.ms) && step.ms >= 0 && step.ms <= 5000) {
      out.push(0x80, step.ms >> 8, step.ms & 255);
    } else throw new Error('Некорректное действие макроса');
  }
  out.push(255);
  return Uint8Array.from(out);
}
