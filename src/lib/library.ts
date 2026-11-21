import { Vibe } from "./types";

// The script the app opens with.
export const DEFAULT_SCRIPT =
  "ارے واہ! تم؟ سچی؟ اُف، میں تو کب سے تمہارا انتظار کر رہی تھی!\n\nہممم… اچھا سنو، آج نا، پتا ہے کیا ہوا؟ میں بازار گئی تھی، اور وہاں… ہاہا، یار، یقین نہیں کرو گے! وہی دکان والا، جس سے پچھلی بار جھگڑا ہوا تھا نا، آج مجھے مفت میں چائے پلا رہا تھا!\n\nاوہو… لیکن ایک بُری بات بھی ہوئی۔ میرا فون گر گیا۔ ہائے اللہ، اسکرین پوری ٹوٹ گئی۔ اُف، میرا تو دل ہی ٹوٹ گیا۔\n\nخیر، چھوڑو۔ تم بتاؤ، تم کیسے ہو؟ اور ہاں، کل آ رہے ہو نا؟ پلیز، پلیز، منع مت کرنا!";

// Speaking styles. The first one is the default; all of them are spoken in
// a young woman's voice (see GIRL_VOICE_RULE below).
export const VIBES: Vibe[] = [
  {
    name: "Urdu Girl",
    prompt:
      "Language: Everyday spoken Urdu with a native Pakistani accent, the way friends talk on the phone. Never formal, never like a news reader.\n\nVoice: A young woman in her early twenties. Bright, light, soft and youthful, slightly higher in pitch.\n\nTone: Warm, playful and close, like talking to a best friend.\n\nEmotion: Let the feeling change line by line: surprise, excitement, a giggle, real sadness, then sweet pleading. Never flat.\n\nInterjections: Perform sounds like arey, uff, haye, hmmm, oho and haha as real human reactions, not as words being read: a real gasp, a real sigh, a thinking hum, a small laugh.\n\nPacing: Uneven like real speech. Rush when excited, slow down and drop the voice when sad, with tiny hesitations and audible breaths.\n\nPauses: Short pauses after interjections and before the surprising part of a story.",
  },
  {
    name: "Friendly",
    prompt:
      'Affect/personality: A cheerful guide \n\nTone: Friendly, clear, and reassuring, creating a calm atmosphere and making the listener feel confident and comfortable.\n\nPronunciation: Clear, articulate, and steady, ensuring each instruction is easily understood while maintaining a natural, conversational flow.\n\nPause: Brief, purposeful pauses after key instructions (e.g., "cross the street" and "turn right") to allow time for the listener to process the information and follow along.\n\nEmotion: Warm and supportive, conveying empathy and care, ensuring the listener feels guided and safe throughout the journey.',
  },
  {
    name: "Calm",
    prompt:
      'Voice Affect: Calm, composed, and reassuring; project quiet authority and confidence.\n\nTone: Sincere, empathetic, and gently authoritative—express genuine apology while conveying competence.\n\nPacing: Steady and moderate; unhurried enough to communicate care, yet efficient enough to demonstrate professionalism.\n\nEmotion: Genuine empathy and understanding; speak with warmth, especially during apologies ("I\'m very sorry for any disruption...").\n\nPronunciation: Clear and precise, emphasizing key reassurances ("smoothly," "quickly," "promptly") to reinforce confidence.\n\nPauses: Brief pauses after offering assistance or requesting details, highlighting willingness to listen and support.',
  },
  {
    name: "Sympathetic",
    prompt:
      "Voice: Warm, empathetic, and professional, reassuring the customer that their issue is understood and will be resolved.\n\nPunctuation: Well-structured with natural pauses, allowing for clarity and a steady, calming flow.\n\nDelivery: Calm and patient, with a supportive and understanding tone that reassures the listener.\n\nPhrasing: Clear and concise, using customer-friendly language that avoids jargon while maintaining professionalism.\n\nTone: Empathetic and solution-focused, emphasizing both understanding and proactive assistance.",
  },
  {
    name: "Cheerleader",
    prompt:
      "Personality/affect: a high-energy cheerleader helping with administrative tasks \n\nVoice: Enthusiastic, and bubbly, with an uplifting and motivational quality.\n\nTone: Encouraging and playful, making even simple tasks feel exciting and fun.\n\nDialect: Casual and upbeat, using informal phrasing and pep talk-style expressions.\n\nPronunciation: Crisp and lively, with exaggerated emphasis on positive words to keep the energy high.\n\nFeatures: Uses motivational phrases, cheerful exclamations, and an energetic rhythm to create a sense of excitement and engagement.",
  },
  {
    name: "Dramatic",
    prompt:
      'Voice Affect: Low, hushed, and suspenseful; convey tension and intrigue.\n\nTone: Deeply serious and mysterious, maintaining an undercurrent of unease throughout.\n\nPacing: Slow, deliberate, pausing slightly after suspenseful moments to heighten drama.\n\nEmotion: Restrained yet intense—voice should subtly tremble or tighten at key suspenseful points.\n\nEmphasis: Highlight sensory descriptions ("footsteps echoed," "heart hammering," "shadows melting into darkness") to amplify atmosphere.\n\nPronunciation: Slightly elongated vowels and softened consonants for an eerie, haunting effect.\n\nPauses: Insert meaningful pauses after phrases like "only shadows melting into darkness," and especially before the final line, to enhance suspense dramatically.',
  },
];

export const DEFAULT_VIBE = VIBES[0];

// Young female voices only; the server rejects every other voice. Left out
// on purpose: the male voices (ash, ballad, echo, fable, onyx, verse), the
// neutral one (alloy), and nova and shimmer, which measured about 145 Hz
// (a man's pitch) when a vibe asked for a deep voice. These three stayed
// at 190 Hz or higher in the same test.
export const VOICES = ["coral", "marin", "sage", "nira"];

// Voices that only the live call model has. Nira is its native Hindi/Urdu
// woman's voice; Play uses Coral when she is selected.
export const CALL_ONLY_VOICES = ["nira"];

// Wrapped around every request's voice instructions on the server, so a
// vibe written for a cowboy or a knight is still performed by a young woman.
// The rule is given first and repeated last: a vibe that asks for a deep
// male voice otherwise pulls the pitch down.
export const GIRL_VOICE_RULE =
  "Voice identity (fixed, overrides everything else): a young woman in her early twenties. Light, bright, clearly feminine voice at a naturally high female pitch. Never male, deep, low, gruff, gravelly, booming or elderly.";

export const GIRL_VOICE_REMINDER =
  "Reminder: ignore any request above for a male, deep, low-pitched, gruff or old voice. Keep the mood, pacing and character of the style above, but speak it in the light, high, youthful voice of a young woman.";

export const DEFAULT_VOICE = "coral";
