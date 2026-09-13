#!/usr/bin/env node
// Builds the announcer voice pack (client/audio/voice/*.wav + manifest.json) from Windows speech synthesis:
//   1. PowerShell + System.Speech renders every line with the "Zira" voice at the lowest SSML pitch (22050 Hz mono 16-bit),
//   2. this script trims the silence, resamples the take down (PITCH < 1: deeper voice, formants included - the Q3 announcer
//      register), drives it through a soft saturator, adds a short arena slap-back and a vintage lowpass, normalizes the
//      peak and writes 16-bit PCM WAVs the client decodes with decodeAudioData().
// Usage: node tools/voice_build.mjs [--raw DIR] [--no-tts] [--pitch 0.78] [--rate fast] [--only fight,excellent]
//   --no-tts reuses the raw takes of a previous run (kept in --raw, default <scratch>/voice_raw) so processing can be re-tuned
//   without re-synthesizing. Windows only for the synthesis step (the processing step is portable).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'client', 'audio', 'voice');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : []).filter(Boolean));
const RAW = path.resolve(args.raw || path.join(os.tmpdir(), 'arena_voice_raw'));
const PITCH = +(args.pitch || 0.68);       // resample factor: 0.68 = about -6.7 semitones (formants follow: a bigger chest); deeper than this smears the consonants
const RATE = args.rate || 'fast';          // SSML prosody rate before the slow-down; 'fast' keeps the articulation clean ('x-fast' slurs Zira)
const VOICE = args.voice || 'Microsoft Zira Desktop';
const SR = 22050;

// name -> spoken text (Q3's sound/feedback set, plus a welcome line). Keys are the clip names the client asks for.
export const LINES = {
  welcome: 'Welcome to the arena.',
  prepare: 'Prepare to fight.',
  three: 'Three.', two: 'Two.', one: 'One.',
  fight: 'Fight!',
  excellent: 'Excellent!',
  impressive: 'Impressive!',
  humiliation: 'Humiliation!',
  perfect: 'Perfect!',
  taken_lead: 'You have taken the lead.',
  lost_lead: 'You have lost the lead.',
  tied_lead: 'Tied for the lead.',
  one_minute: 'One minute warning.',
  five_minute: 'Five minute warning.',
  one_frag: 'One frag left.',
  two_frags: 'Two frags left.',
  three_frags: 'Three frags left.',
  sudden_death: 'Sudden death.',
  you_win: 'You win.',
  you_lose: 'You lose.',
};
const only = args.only ? String(args.only).split(',') : null;
const names = Object.keys(LINES).filter((n) => !only || only.includes(n));

// ---------- 1. synthesis ----------
function synthesize() {
  fs.mkdirSync(RAW, { recursive: true });
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;');
  const items = names.map((n) => `@('${n}','${esc(LINES[n])}')`).join(',');
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('${VOICE}')
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SR}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($t in @(${items})) {
  $s.SetOutputToWaveFile((Join-Path '${RAW.replace(/'/g, "''")}' ($t[0] + '.wav')), $fmt)
  $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><prosody pitch="x-low" rate="${RATE}" volume="x-loud">' + $t[1] + '</prosody></speak>'
  $s.SpeakSsml($ssml)
  $s.SetOutputToNull()
}
'ok'`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0 || !/ok/.test(r.stdout)) throw new Error(`speech synthesis failed: ${r.stderr || r.stdout}`);
}

// ---------- 2. processing ----------
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV`);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt/data chunk`);
  if (fmt.bits !== 16) throw new Error(`${file}: expected 16-bit PCM`);
  const n = Math.floor(data.length / 2 / fmt.channels); const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2); out[i] = s / fmt.channels / 32768; }
  return { rate: fmt.rate, samples: out };
}
function writeWav(file, samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}
const trim = (x, rate, thr = 0.012, padIn = 0.01, padOut = 0.08) => {
  let a = 0, b = x.length - 1;
  while (a < x.length && Math.abs(x[a]) < thr) a++;
  while (b > a && Math.abs(x[b]) < thr) b--;
  a = Math.max(0, a - Math.round(padIn * rate)); b = Math.min(x.length - 1, b + Math.round(padOut * rate));
  return x.subarray(a, b + 1);
};
const resample = (x, factor) => { // plays the take at `factor` speed (pitch and formants follow), linear interpolation is plenty at 22 kHz speech
  const n = Math.floor(x.length / factor); const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const s = i * factor, j = Math.floor(s), f = s - j; out[i] = x[j] * (1 - f) + (x[Math.min(j + 1, x.length - 1)] || 0) * f; }
  return out;
};
const onePole = (x, rate, cutoff, high = false) => { const k = Math.exp(-2 * Math.PI * cutoff / rate); const out = new Float32Array(x.length); let y = 0; for (let i = 0; i < x.length; i++) { y = (1 - k) * x[i] + k * y; out[i] = high ? x[i] - y : y; } return out; };
const saturate = (x, drive = 2.4) => { const norm = Math.tanh(drive); const out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = Math.tanh(x[i] * drive) / norm; return out; };
// Arena slap-back: three early reflections plus one damped feedback line, mixed under the dry voice.
const reverb = (x, rate, { wet = 0.32, taps = [[0.019, 0.5], [0.031, 0.35], [0.047, 0.25]], loop = 0.083, fb = 0.38, damp = 2600, tail = 0.5 } = {}) => {
  const n = x.length + Math.round(tail * rate); const out = new Float32Array(n); const line = new Float32Array(n);
  for (let i = 0; i < x.length; i++) out[i] = x[i];
  for (const [d, g] of taps) { const k = Math.round(d * rate); for (let i = 0; i < x.length; i++) out[i + k] += x[i] * g * wet; }
  const k = Math.round(loop * rate); const a = Math.exp(-2 * Math.PI * damp / rate); let lp = 0;
  for (let i = 0; i < n; i++) { const src = (i < x.length ? x[i] : 0) + (i >= k ? line[i - k] * fb : 0); lp = (1 - a) * src + a * lp; line[i] = lp; if (i >= k) out[i] += line[i - k] * wet * 0.6; }
  return out;
};
const normalize = (x, peak = 0.89) => { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); const g = m > 0 ? peak / m : 1; const out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = x[i] * g; return out; };
const fadeOut = (x, rate, ms = 40) => { const k = Math.min(x.length, Math.round(ms / 1000 * rate)); for (let i = 0; i < k; i++) x[x.length - 1 - i] *= i / k; return x; };

function processClip(name) {
  const { rate, samples } = readWav(path.join(RAW, `${name}.wav`));
  let x = trim(samples, rate);
  x = resample(x, PITCH);
  x = onePole(x, rate, 60, true);           // rumble off, keep the chest
  { const low = onePole(x, rate, 260); for (let i = 0; i < x.length; i++) x[i] += low[i] * 0.9; } // +5.6 dB low shelf below 260 Hz (the Q3 announcer's weight)
  x = saturate(normalize(x, 0.8), 1.7);     // a little grit, evenly for every line (more eats the consonants)
  x = reverb(x, rate, { wet: 0.22 });
  x = onePole(x, rate, 6500);               // vintage 22 kHz feel, consonants kept
  x = fadeOut(normalize(x, 0.89), rate);
  if (rate !== SR) x = resample(x, rate / SR);
  writeWav(path.join(OUT, `${name}.wav`), x, SR);
  return { ms: Math.round(x.length / SR * 1000) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!args['no-tts']) { console.log(`synthesizing ${names.length} lines with "${VOICE}" (rate ${RATE}) -> ${RAW}`); synthesize(); }
  fs.mkdirSync(OUT, { recursive: true });
  const manifestFile = path.join(OUT, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
  let total = 0;
  for (const n of names) { const r = processClip(n); manifest[n] = { file: `${n}.wav`, text: LINES[n], ms: r.ms }; total += fs.statSync(path.join(OUT, `${n}.wav`)).size; console.log(`${n.padEnd(14)} ${String(r.ms).padStart(5)} ms  "${LINES[n]}"`); }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
  console.log(`pack: ${names.length} clips, ${(total / 1024).toFixed(0)} KB, pitch ${PITCH}`);
}
