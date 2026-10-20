/**
 * @archivo scripts/gen-voice-previews.mjs
 * @modulo QA / Assets — Generador de clips de preview de voz (Landing pública)
 * @proposito
 *   Regenerar los 21 clips WAV estáticos que sirve la landing en
 *   /demo-voices/<MOTOR>-<voz>.wav y que reproduce el botón «▶ Probar voz» de
 *   `LiveInteractiveVoiceDemo.tsx`. Para cada voz del catálogo se abre una sesión
 *   con el proveedor real, se dicta la frase fija «Hola, soy tu asistente de voz
 *   de Onboarding Assistant» y se guarda el audio remuestreado a 16 kHz como WAV
 *   PCM16 mono. Es exactamente el generador de la ola 2026-10-19 22:55 del Ledger,
 *   ahora versionado en el repo (antes vivía fuera, en temp).
 *
 * @uso
 *   node scripts/gen-voice-previews.mjs
 *   - Omite los clips que ya existen: borra el `.wav` para forzar regeneración.
 *   - Requiere en `.env`: QWEN_API_KEY, QWEN_REALTIME_WS_URL (endpoint MaaS del
 *     workspace de Singapur) y GEMINI_API_KEY.
 *
 * @protocolos
 *   - Qwen 3.8 Omni-Realtime: `session.update` (voz anidada en `audio.output.voice`,
 *     entrada 16 kHz, salida 24 kHz) + `conversation.item.create`(input_text) +
 *     `response.create`; recoge `response.audio.delta` (base64) y remuestrea 24→16.
 *   - Gemini Live: `setup` (prebuiltVoiceConfig.voiceName) + turno `clientContent`
 *     de texto; recoge `serverContent.modelTurn.parts[].inlineData` y remuestrea
 *     24→16. Clave de diseño: NO modificar las dependencias de este script; usa
 *     únicamente `ws` del node_modules raíz (resuelto vía `import.meta.url`).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const env = readFileSync(join(ROOT, '.env'), 'utf8');
const pick = (n) => { const m = env.match(new RegExp('^' + n + '=(.*)$', 'm')); return m && m[1] !== undefined ? m[1].trim() : ''; };
const QKEY = pick('QWEN_API_KEY');
const QBASE = pick('QWEN_REALTIME_WS_URL');
const GKEY = pick('GEMINI_API_KEY');
const GBASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const PHRASE = 'Hola, soy tu asistente de voz de Onboarding Assistant.';
const OUT = join(ROOT, 'apps', 'web', 'public', 'demo-voices');
mkdirSync(OUT, { recursive: true });

function resample24to16(input) {
  const inS = Math.floor(input.length / 2); const outS = Math.max(1, Math.round(inS * 16000 / 24000));
  const out = Buffer.alloc(outS * 2); const ratio = 24000 / 16000;
  for (let i = 0; i < outS; i++) { const s = i * ratio; const lo = Math.floor(s); const hi = Math.min(lo + 1, inS - 1); const f = s - lo; out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(input.readInt16LE(lo * 2) + (input.readInt16LE(hi * 2) - input.readInt16LE(lo * 2)) * f))), i * 2); }
  return out;
}
function wav16(pcm) { const hdr = Buffer.alloc(44); hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24); hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40); return Buffer.concat([hdr, pcm]); }

function qwenClip(voice) {
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(`${QBASE}?model=qwen3.8-omni-flash-realtime`, { headers: { authorization: `Bearer ${QKEY}` } });
    let pcm = []; let done = false;
    const fin = (ok) => { if (!done) { done = true; try { ws.close(); } catch {} resolvePromise(ok ? Buffer.concat(pcm) : null); } };
    const to = setTimeout(() => fin(pcm.length > 0), 20000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.update', session: { modalities: ['text', 'audio'], turn_detection: null, audio: { input: { format: { type: 'pcm', sample_rate: 16000, sample_format: 's16le', channels: 1, packing: 'interleaved', channel_layout: 'mono' } }, output: { voice, format: { type: 'pcm', sample_rate: 24000 } } } } })));
    ws.on('message', (d) => { let e; try { e = JSON.parse(d.toString()); } catch { return }
      if (e.type === 'session.updated') { ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Repite exactamente esta frase en español, sin nada más: ' + PHRASE }] } })); ws.send(JSON.stringify({ type: 'response.create' })); }
      if (e.type === 'response.audio.delta' && e.delta) pcm.push(Buffer.from(e.delta, 'base64'));
      if (e.type === 'response.done') { clearTimeout(to); fin(pcm.length > 0); }
      if (e.type === 'error') { clearTimeout(to); fin(false); }
    });
    ws.on('error', () => fin(false)); ws.on('close', () => fin(pcm.length > 0));
  });
}
function geminiClip(voice) {
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(`${GBASE}?key=${GKEY}`);
    let pcm = []; let done = false;
    const fin = (ok) => { if (!done) { done = true; try { ws.close(); } catch {} resolvePromise(ok ? Buffer.concat(pcm) : null); } };
    const to = setTimeout(() => fin(pcm.length > 0), 20000);
    ws.on('open', () => ws.send(JSON.stringify({ setup: { model: 'models/gemini-3.8-live', generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }, systemInstruction: { parts: [{ text: 'Responde siempre en español neutro.' }] } } })));
    ws.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return }
      if (m.setupComplete) ws.send(JSON.stringify({ clientContent: { turns: [{ parts: [{ text: 'Di exactamente: ' + PHRASE }], role: 'user' }], turnComplete: true } }));
      const parts = m.serverContent?.modelTurn?.parts; if (Array.isArray(parts)) for (const p of parts) if (p.inlineData?.data) pcm.push(Buffer.from(p.inlineData.data, 'base64'));
      if (m.serverContent?.turnComplete && pcm.length) { clearTimeout(to); fin(true); }
    });
    ws.on('error', () => fin(false)); ws.on('close', () => fin(pcm.length > 0));
  });
}

const QWEN = ['Tina', 'Serena', 'Cici', 'Maia', 'Ryan', 'Evan', 'Jennifer', 'Sonrisa', 'Bodega', 'Andre'];
const GEMINI = ['Kore', 'Aoede', 'Leda', 'Despina', 'Sulafat', 'Callirrhoe', 'Zephyr', 'Puck', 'Charon', 'Orus', 'Algieba'];

for (const v of QWEN) { if (existsSync(join(OUT, `QWEN-${v}.wav`))) { console.log(`QWEN ${v}: ya existe`); continue; } const p = await qwenClip(v); if (p && p.length > 2) { writeFileSync(join(OUT, `QWEN-${v}.wav`), wav16(resample24to16(p))); console.log(`QWEN ${v}: ${p.length}B ok`); } else console.log(`QWEN ${v}: SIN AUDIO`); }
for (const v of GEMINI) { if (existsSync(join(OUT, `GEMINI-${v}.wav`))) { console.log(`GEMINI ${v}: ya existe`); continue; } const p = await geminiClip(v); if (p && p.length > 2) { writeFileSync(join(OUT, `GEMINI-${v}.wav`), wav16(resample24to16(p))); console.log(`GEMINI ${v}: ${p.length}B ok`); } else console.log(`GEMINI ${v}: SIN AUDIO`); }
console.log('LISTO');
