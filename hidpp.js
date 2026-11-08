// HID++ over the browser's WebHID API. All communication stays on this device.
export const LOGITECH = 0x046d;
const LONG = 0x11;
const RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

export class Hidpp {
  constructor(device) {
    this.device = device;
    this.session = crypto.randomUUID();
    this.index = 0xff;
    this.features = new Map();
    this.pending = null;
    this.onInput = this.onInput.bind(this);
    device.addEventListener('inputreport', this.onInput);
  }

  onInput(event) {
    if (!this.pending || event.reportId !== LONG) return;
    const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const p = this.pending;
    if (data.length < 4 || data[0] !== p.index) return;
    if ((data[1] === 0xff || data[1] === 0x8f) && data[2] === p.feature && data[3] === p.command) {
      p.reject(new Error(`Устройство отклонило запрос (HID++ ${data[4]?.toString(16) ?? '?'})`));
    } else if (data[1] === p.feature && data[2] === p.command) {
      p.resolve(data.slice(3));
    }
  }

  async call(feature, fn, params = [], timeout = 1500) {
    if (this.pending) throw new Error('Предыдущий запрос ещё выполняется');
    const command = (fn << 4) | 0x0a;
    const out = new Uint8Array(19);
    out.set([this.index, feature, command, ...params].slice(0, 19));
    let timer;
    const response = new Promise((resolve, reject) => {
      this.pending = { index: this.index, feature, command, resolve, reject };
      timer = setTimeout(() => reject(new Error('Устройство не ответило на запрос HID++')), timeout);
    });
    try {
      await this.device.sendReport(LONG, out);
      return await response;
    } catch (error) {
      // Attach a rejection handler if sendReport fails before the response is awaited.
      response.catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      this.pending = null;
    }
  }

  async connect() {
    await this.device.open();
    for (const index of [0xff, 1, 2, 3, 4, 5, 6]) {
      this.index = index;
      try {
        const reply = await this.call(0, 1, [0, 0, 0x5a], 900);
        if (reply[2] === 0x5a) return;
      } catch { /* Try the next receiver slot. */ }
    }
    throw new Error('Мышь не ответила. Выберите другой интерфейс устройства или разбудите беспроводную мышь.');
  }

  async feature(id) {
    if (this.features.has(id)) return this.features.get(id);
    const p = await this.call(0, 0, [id >> 8, id & 255]);
    const index = p[0] || 0;
    this.features.set(id, index);
    return index;
  }

  async readDpi() {
    const extended = await this.feature(0x2202);
    if (extended) {
      const current = await this.call(extended, 5, [0]);
      const capabilities = await this.call(extended, 1, [0]).catch(() => null);
      const bytes = [];
      for (let page = 0; page < 8; page++) {
        let reply;
        try { reply = await this.call(extended, 2, [0, 0, page]); }
        catch (error) { if (!page) throw error; break; }
        const data = Array.from(reply.slice(3));
        if (data.every(v => v === 0)) break;
        bytes.push(...data);
      }
      const values = dpiValues(bytes);
      if (!values.length || current.length < 10) throw new Error('Не удалось прочитать диапазон DPI');
      return { feature: extended, extended: true, current: word(current, 1), currentY: word(current, 5), min: values[0], max: values.at(-1), values, lod: current[9], lodSupported: !!(capabilities?.[2] & 2) };
    }
    const index = await this.feature(0x2201);
    if (!index) return null;
    const current = await this.call(index, 2, [0]);
    const list = await this.call(index, 1, [0]);
    const values = dpiValues(Array.from(list.slice(1)));
    if (!values.length) throw new Error('Не удалось прочитать диапазон DPI');
    return { feature: index, extended: false, current: word(current, 1), min: values[0], max: values.at(-1), values };
  }

  async setDpi(state, requested) {
    const value = state.values.reduce((best, v) => Math.abs(v - requested) < Math.abs(best - requested) ? v : best);
    const hi = value >> 8, lo = value & 255;
    if (state.extended) await this.call(state.feature, 6, [0, hi, lo, hi, lo, state.lod]);
    else await this.call(state.feature, 3, [0, hi, lo]);
    return this.readDpi();
  }

  async setLod(state, lod) {
    if (!state.extended || !state.lodSupported || ![1, 2, 3].includes(lod)) throw new Error('Высота отрыва не поддерживается');
    const x = state.current, y = state.currentY;
    await this.call(state.feature, 6, [0, x >> 8, x & 255, y >> 8, y & 255, lod]);
    return this.readDpi();
  }

  async readRate() {
    const connection = this.index === 0xff ? 0 : 1;
    const extended = await this.feature(0x8061);
    if (extended) {
      const list = await this.call(extended, 1, [connection]);
      const current = await this.call(extended, 2, [connection]);
      const rates = RATES.filter((_, i) => list[1] & (1 << i));
      return rates.length && RATES[current[0]] ? { feature: extended, extended: true, connection, rates, current: RATES[current[0]] } : null;
    }
    const index = await this.feature(0x8060);
    if (!index) return null;
    const list = await this.call(index, 0);
    const current = await this.call(index, 1);
    const rates = Array.from({ length: 8 }, (_, i) => i + 1).filter(i => list[0] & (1 << (i - 1))).map(i => Math.floor(1000 / i)).sort((a, b) => a - b);
    return rates.length && current[0] ? { feature: index, extended: false, rates, current: Math.floor(1000 / current[0]) } : null;
  }

  async setRate(state, hz) {
    if (!state.rates.includes(hz)) throw new Error('Частота не поддерживается устройством');
    if (state.extended) await this.call(state.feature, 3, [state.connection, RATES.indexOf(hz)]);
    else await this.call(state.feature, 2, [Math.round(1000 / hz)]);
    return this.readRate();
  }

  async readBattery() {
    const index = await this.feature(0x1004);
    if (index) {
      const caps = await this.call(index, 0);
      const state = await this.call(index, 1);
      const coarse = state[1] & 8 ? 90 : state[1] & 4 ? 50 : state[1] & 2 ? 20 : state[1] & 1 ? 5 : 0;
      return { percent: caps[1] & 2 && state[0] > 0 ? Math.min(state[0], 100) : coarse, charging: state[2] === 1 || state[2] === 2, approximate: !(caps[1] & 2) };
    }
    const level = await this.feature(0x1000);
    if (level) {
      const state = await this.call(level, 0);
      return { percent: Math.min(state[0], 100), charging: state[2] === 1 || state[2] === 2, approximate: false };
    }
    const voltage = await this.feature(0x1001);
    if (!voltage) return null;
    const state = await this.call(voltage, 0);
    const percent = Math.round((Math.max(3500, Math.min(4186, word(state, 0))) - 3500) / 686 * 100);
    return { percent, charging: !!(state[2] & 0x80), approximate: true };
  }

  async readMode() {
    const index = await this.feature(0x8100);
    if (!index) return null;
    const result = await this.call(index, 2);
    return { feature: index, value: result[0] };
  }

  async setMode(mode, value) {
    if (![1, 2].includes(value)) throw new Error('Неизвестный режим устройства');
    await this.call(mode.feature, 1, [value]);
    return this.readMode();
  }

  async readLighting() {
    let feature = await this.feature(0x8070);
    const rgb = !feature;
    if (rgb) feature = await this.feature(0x8071);
    if (!feature) return null;
    const info = await this.call(feature, 0, rgb ? [255, 255, 0] : [255, 0, 0]);
    const count = rgb ? info[2] : info[0];
    if (count > 16) throw new Error('Устройство вернуло неверное число зон подсветки');
    const zones = [];
    for (let i = 0; i < count; i++) {
      const zone = await this.call(feature, rgb ? 0 : 1, rgb ? [i, 255, 0] : [i]);
      const location = rgb ? word(zone, 2) : word(zone, 1);
      const effectCount = rgb ? zone[4] : zone[3];
      const effects = [];
      for (let e = 0; e < Math.min(effectCount, 16); e++) {
        const reply = await this.call(feature, rgb ? 0 : 2, rgb ? [i, e, 0] : [i, e]);
        effects.push(reply[3]);
      }
      zones.push({ index: i, location, effects });
    }
    return { feature, rgb, zones };
  }

  async setLighting(lighting, zone, effect, color, period, brightness, persist) {
    const selected = lighting.zones.find(z => z.index === zone);
    const effectIndex = selected?.effects.indexOf(effect) ?? -1;
    if (effectIndex < 0) throw new Error('Эффект не поддерживается выбранной зоной');
    if (!/^#[0-9a-f]{6}$/i.test(color) || !Number.isInteger(period) || period < 100 || period > 60000 || !Number.isInteger(brightness) || brightness < 0 || brightness > 100) throw new Error('Некорректные параметры подсветки');
    const colorBytes = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const payload = Array(13).fill(0);
    payload[0] = zone;
    payload[1] = effectIndex;
    if (effect === 1 || effect === 10) payload.splice(2, 3, ...colorBytes);
    if (effect === 10) { payload[5] = period >> 8; payload[6] = period & 255; payload[8] = brightness; }
    if (effect === 3) { payload[7] = period >> 8; payload[8] = period & 255; payload[9] = brightness; }
    payload[12] = persist ? 1 : 0;
    if (lighting.rgb) {
      await this.call(lighting.feature, 5, [1, 3, 5]);
      if (effect === 1) payload[5] = 2;
    }
    await this.call(lighting.feature, lighting.rgb ? 1 : 3, payload);
  }

  async close() {
    this.device.removeEventListener('inputreport', this.onInput);
    if (this.device.opened) await this.device.close();
  }
}

function word(data, offset) { return (data[offset] << 8) | data[offset + 1]; }

export function dpiValues(bytes) {
  const words = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const value = word(bytes, i);
    if (!value) break;
    words.push(value);
  }
  const values = [];
  for (let i = 0; i < words.length;) {
    const start = words[i];
    if (start >= 0xe000) { i++; continue; }
    if (i + 2 < words.length && (words[i + 1] & 0xe000) === 0xe000 && words[i + 2] < 0xe000) {
      const step = words[i + 1] & 0x1fff, end = words[i + 2];
      if (step && end >= start) for (let value = start; value <= end; value += step) values.push(value);
      i += 2;
    } else { values.push(start); i++; }
  }
  return [...new Set(values)].sort((a, b) => a - b);
}
