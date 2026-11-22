// Visible speech shapes shared by the mesh (Oculus targets) and the head (ARKit).
// Weights are typical durations in seconds. Recorded audio sets the actual pace.
export type Viseme = "sil" | "PP" | "FF" | "TH" | "DD" | "kk" | "CH" | "SS" | "nn" | "RR" | "aa" | "E" | "I" | "O" | "U";
export type Articulation = { viseme: Viseme; weight: number };
export type TimedViseme = { viseme: Viseme; start: number; end: number };
export type VisemeBlend = { from: Viseme; to: Viseme; mix: number };

// Short vowels usually go unwritten in Urdu. Supply them for common spoken
// words. The Latin entries also cover English spellings that differ sharply
// from Roman Urdu, e.g. English "ph" versus Urdu aspirated "ph".
const readings = new Map(Object.entries({
  "میں": "me", "میری": "meyree", "میرا": "meyraa", "آپ": "aap",
  "ہم": "ham", "تم": "tum", "وہ": "wo", "یہ": "yeh", "ہوں": "hoo",
  "ہے": "e", "ہیں": "e", "ہاں": "haan", "نہیں": "naheen",
  "اور": "or", "ایک": "ek", "اس": "is", "بس": "bas", "پر": "par",
  "پھر": "phir", "کچھ": "kuchh", "کیوں": "kyoo", "کون": "kon",
  "کیا": "kyaa", "کہ": "keh", "کیسے": "kaisey", "کیسی": "kaisee",
  "اب": "ab", "سب": "sab", "بات": "baat", "بہت": "bohat",
  "کہاں": "kahaan", "یہاں": "yahaan", "وہاں": "wahaan",
  "مجھے": "mujhey", "تمہیں": "tumhain", "سن": "sun", "سمجھ": "samajh",
  "وقت": "waqt", "شکریہ": "shukriyaa", "ٹھیک": "theek",
  "موبائل": "mobaail", "فون": "fon", "ویڈیو": "veediyo", "پیار": "pyaar",
  "میرے": "mere", "کر": "kar", "رہی": "rahee", "رہا": "rahaa",
  "سلام": "salaam", "دوست": "dost", "دل": "dil", "کل": "kal",
  "پھول": "phool", "پل": "pal", "بول": "bol", "پانی": "paanee",
  aur: "or", kaun: "kon", aik: "ek", mein: "me", main: "me", hai: "e", hain: "e", kyun: "kyoo", hoon: "hoo",
  hello: "helo", please: "pleez", phone: "fon", photo: "foto",
  office: "ofis", sorry: "soree", sure: "shor", time: "taaim", speak: "speek",
  voice: "vois", video: "vidiyo", mic: "maaik", call: "kaul",
  thanks: "θanks", thank: "θank", the: "θuh", with: "wiθ",
  you: "yoo", your: "yor", one: "wan", two: "too", three: "θree",
  english: "inglish", listen: "lisan", message: "mesij", okay: "okey",
}));

// Transliterate unfamiliar Urdu words before grouping their visible sounds.
// A do-chashmi he marks aspiration on the preceding consonant. A standalone
// he has its own sound. Keep explicit vowel marks when they are present.
const urduLetters: Record<string, string> = {
  ا:"a", آ:"aa", ب:"b", پ:"p", ت:"t", ٹ:"tt", ث:"s", ج:"j", چ:"ch",
  ح:"h", خ:"kh", د:"d", ڈ:"dd", ذ:"z", ر:"r", ڑ:"r", ز:"z", ژ:"zh",
  س:"s", ش:"sh", ص:"s", ض:"z", ط:"t", ظ:"z", ع:"a", غ:"gh", ف:"f",
  ق:"q", ک:"k", ك:"k", گ:"g", ل:"l", م:"m", ن:"n", ں:"", و:"o",
  ہ:"h", ه:"h", ة:"h", ۃ:"h", ھ:"h", ء:"", ؤ:"o", ی:"ee", ي:"ee",
  ى:"ee", ئ:"y", ے:"e", ۓ:"e", أ:"a", إ:"i", ٱ:"a", "ٰ":"aa",
  "َ":"a", "ِ":"i", "ُ":"u", "ً":"an", "ٍ":"in", "ٌ":"un", "ْ":"",
};
const urduVowel = /[اآأإٱوؤیيىےۓئںء\u064b-\u0652\u0670]/u;
function urduReading(word: string) {
  const letters = Array.from(word);
  let reading = "";
  let cluster = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters[i], next = letters[i + 1];
    if (c === "ّ") {
      reading += urduLetters[letters[i - 1]] ?? "";
      continue;
    }
    if (c === "ا" && next && /[ویيے\u064b-\u0652]/u.test(next)) continue;
    let sound = urduLetters[c] ?? "";
    if (i === 0 && /[وؤ]/u.test(c)) sound = "w";
    if (i === 0 && /[یي]/u.test(c)) sound = "y";
    if (i > 0 && c === "ا") sound = "aa";
    if (!urduVowel.test(c) && c !== "ھ") {
      if (cluster === 1) {
        reading += "a";
        cluster = 0;
      } else {
        cluster++;
      }
    } else if (c !== "ھ") {
      cluster = 0;
    }
    reading += sound;
  }
  return reading;
}

// A Hindi transcript may arrive in Devanagari even for the same spoken
// Hindustani phrase. Use its written vowel signs and conjuncts directly.
const hindiConsonants: Record<string, string> = {
  क: "k", ख: "kh", ग: "g", घ: "gh", ङ: "ng", च: "ch", छ: "chh", ज: "j",
  झ: "jh", ञ: "n", ट: "tt", ठ: "th", ड: "dd", ढ: "dh", ण: "n", त: "t",
  थ: "th", द: "d", ध: "dh", न: "n", प: "p", फ: "ph", ब: "b", भ: "bh",
  म: "m", य: "y", र: "r", ल: "l", व: "v", श: "sh", ष: "sh", स: "s", ह: "h",
};
const hindiVowels: Record<string, string> = {
  अ: "a", आ: "aa", इ: "i", ई: "ee", उ: "u", ऊ: "oo", ए: "e", ऐ: "e",
  ओ: "o", औ: "o", ऋ: "ri", "ा": "aa", "ि": "i", "ी": "ee", "ु": "u",
  "ू": "oo", "े": "e", "ै": "e", "ो": "o", "ौ": "o", "ृ": "ri",
};
const dotted: Record<string, string> = { क: "q", ख: "kh", ग: "gh", ज: "z", फ: "f", ड: "r", ढ: "rh" };
function hindiReading(word: string) {
  const letters = Array.from(word);
  let reading = "";
  for (let i = 0; i < letters.length; i++) {
    const letter = letters[i];
    let consonant = hindiConsonants[letter];
    if (!consonant) {
      reading += hindiVowels[letter] ?? "";
      continue;
    }
    if (letters[i + 1] === "़") {
      consonant = dotted[letter] ?? consonant;
      i++;
    }
    reading += consonant;
    const next = letters[i + 1];
    if (next === "्") i++;
    else if (next && hindiVowels[next]) reading += hindiVowels[letters[++i]];
    else if (next && hindiConsonants[next]) reading += "a";
  }
  return reading;
}

const single: Record<string, Viseme> = {
  a:"aa", e:"E", i:"I", o:"O", u:"U", p:"PP", b:"PP", m:"PP", f:"FF", v:"FF",
  w:"U", "θ":"TH", t:"DD", d:"DD", k:"kk", g:"kk", q:"kk", x:"kk", c:"kk",
  j:"CH", z:"SS", s:"SS", l:"nn", n:"nn", r:"RR", y:"I", h:"aa",
};
const groups: Record<string, Viseme> = {
  aa:"aa", ee:"I", ii:"I", oo:"U", uu:"U", ey:"E",
  bh:"PP", ph:"PP", th:"DD", dh:"DD", tt:"DD", dd:"DD",
  kh:"kk", gh:"kk", ch:"CH", sh:"CH", zh:"CH", jh:"CH", ng:"nn",
};
const weights: Record<Viseme, number> = {
  sil:0, PP:0.068, FF:0.075, TH:0.066, DD:0.053, kk:0.057, CH:0.084,
  SS:0.083, nn:0.062, RR:0.045, aa:0.089, E:0.095, I:0.085, O:0.10, U:0.095,
};
// A number, currency amount or unsupported script has no reliable reading
// here. Use the acoustic mouth for that span instead of assigning its audio
// to the surrounding known words.
export function supportsArticulation(text: string): boolean {
  if (/[\p{N}\p{S}%٪&#@]/u.test(text)) return false;
  for (const ch of text.normalize("NFKC")) {
    if (/\p{L}/u.test(ch) && !/[a-zA-Z\u0600-\u06ff\u0900-\u097f]/u.test(ch)) return false;
  }
  return true;
}

function wordsOf(text: string): Articulation[][] {
  if (!supportsArticulation(text)) return [];
  const words = text.normalize("NFKC").toLowerCase().replace(/[\u0640\u200c\u200d]/gu, "")
    .match(/[\p{L}\p{M}]+/gu) ?? [];
  return words.map(word => {
    let reading = readings.get(word);
    if (reading === undefined) {
      if (/[\u0600-\u06ff]/u.test(word)) reading = urduReading(word);
      else if (/[\u0900-\u097f]/u.test(word)) reading = hindiReading(word);
      else reading = word;
    }
    const phones: Articulation[] = [];
    for (let i = 0; i < reading.length; i++) {
      const pair = reading.slice(i, i + 2);
      const sound = groups[pair] ?? single[reading[i]];
      if (!sound) continue;
      let weight = weights[sound];
      if (groups[pair]) {
        if (/^[aeiou]/u.test(pair)) weight *= 1.5;
        else if (pair.endsWith("h")) weight *= 1.18;
        i++;
      }
      const prev = phones[phones.length - 1];
      if (prev?.viseme === sound) prev.weight += weight * 0.65;
      else phones.push({ viseme: sound, weight });
    }
    return phones;
  }).filter(word => word.length);
}

export function articulate(text: string): Articulation[] {
  return wordsOf(text).flat();
}

const openness: Record<Viseme, number> = {
  sil: 0, PP: 0.1, FF: 0.26, TH: 0.35, DD: 0.25, kk: 0.25, CH: 0.22,
  SS: 0.25, nn: 0.46, RR: 0.58, aa: 1, E: 0.90, I: 0.8, O: 0.95, U: 0.78,
};
const fricatives = new Set<Viseme>(["FF", "TH", "SS", "CH"]);

// Estimate boundaries on 10 ms RMS frames. Remove long pauses from the
// duration budget, then prefer energy valleys around predicted word breaks.
// Short closures stay inside the budget so /p/, /b/ and /m/ can seal the lips.
function speechFrames(pcm: Float32Array, sampleRate: number) {
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const frames = Math.ceil(pcm.length / hop);
  const rms = new Float32Array(frames);
  const crossings = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const begin = f * hop, end = Math.min(pcm.length, begin + hop);
    let sum = 0;
    let flips = 0;
    for (let i = begin; i < end; i++) {
      sum += pcm[i] * pcm[i];
      if (i > begin && (pcm[i] > 0) !== (pcm[i - 1] > 0)) flips++;
    }
    crossings[f] = Math.min(1, flips * sampleRate / ((end - begin) * 6000));
    rms[f] = Math.sqrt(sum / (end - begin));
    peak = Math.max(peak, rms[f]);
  }
  if (peak < 0.002) return null;
  const threshold = Math.max(0.0018, peak * 0.035);
  const active: number[] = [];
  let last = -1;
  for (let f = 0; f < frames; f++) {
    if (rms[f] < threshold) continue;
    if (last >= 0 && f - last <= 6) {
      for (let j = last + 1; j < f; j++) active.push(j);
    }
    active.push(f);
    last = f;
  }
  return { rms, crossings, peak, active, hop };
}

type Frames = NonNullable<ReturnType<typeof speechFrames>>;

function wordBoundaries(words: Articulation[][], frames: Frames): number[] {
  const { rms, peak, active } = frames;
  const wordWeights = words.map(word => word.reduce((sum, phone) => sum + phone.weight, 0));
  const prefix = [0];
  for (const weight of wordWeights) prefix.push(prefix[prefix.length - 1] + weight);
  const total = prefix[words.length];
  const count = active.length;
  // Long internal pauses often separate words of very unequal lengths.
  // Anchor them first, so all the phones in the next word stay on its
  // side of the pause. Within each resulting phrase the pace can vary.
  const anchors = new Map<number, { frame: number; gap: number }>();
  anchors.set(0, { frame: 0, gap: Infinity });
  anchors.set(words.length, { frame: count, gap: Infinity });
  let boundary = 1;
  for (let j = 1; j < count && words.length > 1; j++) {
    const gap = active[j] - active[j - 1] - 1;
    if (gap < 10) continue;
    const target = j / count * total;
    while (boundary < words.length - 1 &&
      Math.abs(prefix[boundary + 1] - target) < Math.abs(prefix[boundary] - target)) boundary++;
    // Don't force a word break on a brief breath at the very beginning
    // or end of a long word.
    const offset = Math.abs(prefix[boundary] - target);
    const neighbor = target < prefix[boundary] ? wordWeights[boundary - 1] : wordWeights[boundary];
    if (offset <= 0.83 * neighbor && gap > (anchors.get(boundary)?.gap ?? 0)) {
      anchors.set(boundary, { frame: j, gap });
    }
  }

  const boundaries = [0];
  let phraseStart = 0;
  let phraseEnd = 0;
  for (let w = 0; w < words.length; w++) {
    if (w === phraseEnd) {
      phraseStart = w;
      phraseEnd++;
      while (!anchors.has(phraseEnd)) phraseEnd++;
    }
    const begin = anchors.get(phraseStart)!.frame;
    const finish = anchors.get(phraseEnd)!.frame;
    const framesPerWeight = (finish - begin) / (prefix[phraseEnd] - prefix[phraseStart]);
    let wordEnd = finish;
    if (w + 1 < phraseEnd) {
      wordEnd = begin + (prefix[w + 1] - prefix[phraseStart]) * framesPerWeight;
      const radius = Math.min(12, 0.30 * framesPerWeight * Math.min(wordWeights[w], wordWeights[w + 1]));
      let bestCost = Infinity;
      const expected = wordEnd;
      for (let j = Math.max(1, Math.ceil(expected - radius)); j <= Math.min(count - 1, Math.floor(expected + radius)); j++) {
        const afterPause = active[j] > active[j - 1] + 1;
        const energy = Math.min(rms[active[j]], rms[active[j - 1]]) / peak;
        const cost = (afterPause ? -1 : energy) + 0.35 * Math.abs(j - expected) / Math.max(1, radius);
        if (cost < bestCost) {
          bestCost = cost;
          wordEnd = j;
        }
      }
    }
    boundaries.push(wordEnd);
  }
  return boundaries;
}

function phoneBoundary(phone: Articulation, next: Articulation, expected: number, scale: number, frames: Frames) {
  // Look for a release into a vowel, a closing lip or a hiss in the
  // recording near this phone's predicted boundary.
  const { active, rms, crossings, peak } = frames;
  const radius = Math.min(6, Math.min(next.weight, phone.weight) * scale * 0.42);
  const energyChange = openness[next.viseme] - openness[phone.viseme];
  const hissChange = Number(fricatives.has(next.viseme)) - Number(fricatives.has(phone.viseme));
  const first = Math.max(1, Math.ceil(expected - radius));
  const last = Math.min(active.length - 1, Math.floor(expected + radius));
  let best = 0;
  let end = expected;
  for (let j = first; j <= last; j++) {
    const left = active[j - 1], right = active[j];
    const energyEdge = (rms[right] - rms[left]) / peak;
    const hissEdge = crossings[right] - crossings[left];
    const evidence = energyEdge * energyChange + hissEdge * hissChange;
    const cost = 0.08 + 0.18 * Math.abs(j - expected) / Math.max(1, radius);
    if (evidence - cost > best) {
      best = evidence - cost;
      end = j;
    }
  }
  return end;
}

export function alignSpeech(text: string, pcm: Float32Array, sampleRate: number): TimedViseme[] {
  const words = wordsOf(text);
  if (!words.length || !pcm.length || !Number.isFinite(sampleRate) || sampleRate < 1) return [];
  const frames = speechFrames(pcm, sampleRate);
  if (!frames?.active.length) return [];
  const boundaries = wordBoundaries(words, frames);
  const { active, hop } = frames;
  const cues: TimedViseme[] = [];
  for (const [w, word] of words.entries()) {
    const wordStart = boundaries[w], wordEnd = boundaries[w + 1];
    const scale = (wordEnd - wordStart) / word.reduce((sum, p) => sum + p.weight, 0);
    let pos = wordStart;
    let expected = wordStart;
    for (const [i, phone] of word.entries()) {
      expected += phone.weight * scale;
      const next = word[i + 1];
      const end = next ? phoneBoundary(phone, next, expected, scale, frames) : wordEnd;
      // Reinsert the silent gaps omitted above, including gaps within words.
      for (let f = Math.floor(pos); f < Math.ceil(end) && f < active.length; f++) {
        const startSeconds = (active[f] + Math.max(0, pos - f)) * hop / sampleRate;
        const endSeconds = Math.min(pcm.length, (active[f] + Math.min(1, end - f)) * hop) / sampleRate;
        if (endSeconds <= startSeconds) continue;
        const prev = cues[cues.length - 1];
        if (prev?.viseme === phone.viseme && Math.abs(prev.end - startSeconds) < 1e-6) prev.end = endSeconds;
        else cues.push({ viseme: phone.viseme, start: startSeconds, end: endSeconds });
      }
      pos = end;
    }
  }
  return cues;
}

// Coarticulation spans only a few frames around a transition, leaving a
// distinct target in the middle even for quick consonants.
export function sampleSpeech(cues: readonly TimedViseme[], seconds: number): VisemeBlend | null {
  let lo = 0, hi = cues.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cues[mid].end <= seconds) lo = mid + 1;
    else hi = mid;
  }
  const cur = cues[lo];
  if (!cur || seconds < cur.start || !Number.isFinite(seconds)) return null;
  const prev = cues[lo - 1];
  const next = cues[lo + 1];
  function transition(a: TimedViseme, b: TimedViseme): VisemeBlend | null {
    if (Math.abs(b.start - a.end) > 1e-5) return null;
    const width = Math.min(0.026, (a.end - a.start) * 0.32, (b.end - b.start) * 0.32);
    if (width <= 0 || Math.abs(seconds - b.start) >= width) return null;
    const t = (seconds - b.start + width) / (2 * width);
    return { from: a.viseme, to: b.viseme, mix: t * t * (3 - 2 * t) };
  }
  return (prev && transition(prev, cur)) || (next && transition(cur, next)) ||
    { from: cur.viseme, to: cur.viseme, mix: 0 };
}
