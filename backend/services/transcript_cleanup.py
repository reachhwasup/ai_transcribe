"""Parsing and cleanup of raw Gemini transcript output into timed segments."""
import json
import re
from backend.services.voice_profiles import resolve_voice_profile


def _safe_json_loads(text: str) -> list:
    """Parse JSON with fallback repair for common Gemini issues
    (trailing commas, unescaped newlines in strings, etc.)."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Fix 1: Remove trailing commas before ] or }
    fixed = re.sub(r",\s*([}\]])", r"\1", text)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # Fix 2: Also escape unescaped newlines inside string values
    fixed2 = re.sub(r'(?<=": ")((?:[^"\\]|\\.)*)(?=")', lambda m: m.group(0).replace("\n", "\\n"), fixed)
    try:
        return json.loads(fixed2)
    except json.JSONDecodeError:
        pass

    # Fix 3: Salvage every complete top-level object from a truncated/malformed
    # array. Gemini responses get cut off mid-array (token limits, dropped
    # connections), which leaves a trailing half-written object that no repair
    # above can fix. Scan brace-by-brace (respecting strings/escapes), json.loads
    # each balanced {...}, and keep the ones that parse — discarding only the
    # incomplete tail. This recovers nearly all segments instead of losing the
    # whole chunk.
    recovered = []
    depth = 0
    start = -1
    in_str = False
    escape = False
    for i, ch in enumerate(text):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    obj = text[start:i + 1]
                    try:
                        recovered.append(json.loads(obj))
                    except json.JSONDecodeError:
                        try:
                            recovered.append(json.loads(re.sub(r",\s*([}\]])", r"\1", obj)))
                        except json.JSONDecodeError:
                            pass
                    start = -1
    if recovered:
        return recovered

    raise ValueError(f"Could not parse Gemini JSON response: {text[:200]}")


# Gemini sometimes slips letters from other Indic / South-East Asian scripts into Khmer
# output (Thai, Sinhala, Burmese, Lao, Georgian, Devanagari…). They are never valid Khmer,
# so whole runs of them are dropped.
_FOREIGN_SCRIPT_RUN = re.compile(
    r'[\u0900-\u0DFF\u0E00-\u0EFF\u1000-\u109F\u10A0-\u10FF\u0530-\u058F\u0590-\u05FF\u0600-\u06FF]+'
)


def strip_foreign_scripts(text: str) -> str:
    """Remove characters from scripts that cannot appear in Khmer captions."""
    if not text or not _FOREIGN_SCRIPT_RUN.search(text):
        return text
    cleaned = _FOREIGN_SCRIPT_RUN.sub("", text)
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def _clean_khmer_spacing(text: str) -> str:
    """Clean artificial spaces and broken glyph sequences from Khmer text while keeping natural clause structure."""
    if not text:
        return text

    # Strip foreign scripts first. This used to run only after confirming the line held Khmer,
    # which meant a line written entirely in another script skipped cleaning altogether and
    # reached the captions untouched.
    text = strip_foreign_scripts(text)

    # The spacing repairs below only make sense for Khmer glyphs
    if not re.search(r'[\u1780-\u17FF]', text):
        return text.strip()

    # Fix split Khmer subscripts (e.g. consonant + space + ្ + consonant)
    text = re.sub(r'([\u1780-\u17B3])\s+([\u17D2][\u1780-\u17B3])', r'\1\2', text)
    text = re.sub(r'([\u1780-\u17B3][\u17D2])\s+([\u1780-\u17B3])', r'\1\2', text)
    # Fix split vowels/diacritics
    text = re.sub(r'([\u1780-\u17B3])\s+([\u17B4-\u17D1\u17D3])', r'\1\2', text)

    # Normalize multiple whitespace into single space
    text = re.sub(r'\s+', ' ', text)
    # Remove spaces before Khmer punctuation (។, ៗ, ៕, etc.) and general punctuation
    text = re.sub(r'\s+([។ៗ៕!?,:;])', r'\1', text)
    text = re.sub(r'([!?,:;])\s*([។ៗ៕])', r'\1\2', text)
    return text.strip()


# Comprehensive set of music, instrumental, noise, and non-speech sound keywords
_MUSIC_NOISE_TERMS = {
    # Khmer terms (both spellings សម្លេង and សំឡេង, and common compound terms)
    'ភ្លេង', 'តន្ត្រី', 'បទភ្លេង', 'ភ្លេងកំដរ', 'តន្ត្រីកំដរ', 'ចម្រៀង', 'ចម្រៀងកំដរ',
    'សម្លេងភ្លេង', 'សំឡេងភ្លេង', 'សម្លេងតន្ត្រី', 'សំឡេងតន្ត្រី', 'សម្លេងកំដរ', 'សំឡេងកំដរ',
    'សម្លេងចម្រៀង', 'សំឡេងចម្រៀង', 'ចង្វាក់ភ្លេង', 'ចង្វាក់តន្ត្រី', 'ភ្លេងរោទ៍', 'សំឡេងរោទ៍',
    'សម្លេងរោទ៍', 'សំឡេងទះដៃ', 'សម្លេងទះដៃ', 'សំឡេងហ៊ោ', 'សម្លេងហ៊ោ', 'សំឡេងហ៊ោកញ្ជ្រៀវ',
    'សំឡេងសើច', 'សម្លេងសើច', 'សំឡេងយំ', 'សម្លេងយំ', 'សើច', 'យំ', 'ទះដៃ', 'ហ៊ោ', 'កញ្ជ្រៀវ',
    'សំឡេងខ្សឹប', 'សម្លេងខ្សឹប', 'សំឡេងដកដង្ហើម', 'សម្លេងដកដង្ហើម',
    # English terms & compounds
    'music', 'bgm', 'backgroundmusic', 'melody', 'instrumental', 'soundeffect', 'soundeffects',
    'sfx', 'applause', 'cheer', 'cheers', 'cheering', 'tune', 'guitar', 'piano', 'drum', 'drums',
    'beat', 'beats', 'singing', 'song', 'whistling', 'humming', 'laughter', 'laughing', 'crying',
    'musicplaying', 'upbeatmusic', 'dramaticmusic', 'sadmusic', 'instrumentalmusic',
    'bgmusic', 'ost', 'soundtrack', 'theme', 'thememusic', 'audionoise', 'ambientnoise',
    'silence', 'nodialogue', 'actionmusic', 'softmusic', 'intensemusic', 'suspensemusic',
    'intro', 'outro', 'intromusic', 'outromusic', 'sound', 'noise', 'audio',
    # Chinese terms
    '音乐', '背景音乐', '配乐', '乐声', '伴奏', '掌声', '欢呼声', '笑声', '哭声', '尖叫', '叹气', '无声',
}

_MUSIC_REGEX_KEYWORDS = (
    r'ភ្លេង|តន្ត្រី|បទភ្លេង|ភ្លេងកំដរ|តន្ត្រីកំដរ|ចម្រៀង|ចម្រៀងកំដរ|សម្លេងភ្លេង|សំឡេងភ្លេង|'
    r'សម្លេងតន្ត្រី|សំឡេងតន្ត្រី|សម្លេងកំដរ|សំឡេងកំដរ|សម្លេងចម្រៀង|សំឡេងចម្រៀង|ចង្វាក់ភ្លេង|ចង្វាក់តន្ត្រី|'
    r'ភ្លេងរោទ៍|សំឡេងរោទ៍|សម្លេងរោទ៍|សំឡេងទះដៃ|សម្លេងទះដៃ|សំឡេងហ៊ោ|សម្លេងហ៊ោ|'
    r'music|bgm|background\s*music|melody|instrumental|sound\s*effects?|sfx|applause|cheers?|cheering|'
    r'tune|guitar|piano|drum|beat|singing|song|whistling|humming|laughter|laughing|crying|ost|soundtrack|'
    r'theme\s*music|ambient|audio\s*noise|no\s*dialogue|silence|'
    r'音乐|背景音乐|配乐|乐声|伴奏|掌声|欢呼声|笑声|哭声|尖叫|叹气|无声'
)


def _is_music_or_noise_segment(text: str, orig_text: str = "") -> bool:
    """Check if text is purely a background music/noise tag (e.g. [ភ្លេង], [តន្ត្រី], [Music], (Sound effect)) or pure music emojis.
    Plain spoken dialogue is NEVER filtered out."""
    for t in (text, orig_text):
        if not t:
            continue
        cleaned = str(t).strip()
        if not cleaned:
            continue

        # 1. Pure music notes / audio emoji symbols
        if re.fullmatch(r'[\s🎵🎶🎼🔊🔉🔈🔔🎸🎹🎺🎻🥁🎤🎧.,!?:;\-–—~`\'"“”«»\[\]\(\)（）【】「」『』《》⟨⟩‹›]+', cleaned):
            return True

        # 2. Explicitly bracketed tags: [ភ្លេង], (តន្ត្រី), 【Music】, [Upbeat Music Playing], (ភ្លេងកំដរ...), [Sound Effect], etc.
        # Must have an explicit opening bracket at start and closing bracket at end
        bracket_match = re.match(
            r'^\s*[\[\(（【「『《⟨\{](?P<inner>.+?)[\]\)）】」』》⟩\}][\s.,!?:;\-–—~`\'"“”«»]*$',
            cleaned,
            flags=re.IGNORECASE
        )
        if bracket_match:
            inner = bracket_match.group("inner").strip()
            inner_stripped = re.sub(r'[\s.,!?:;\-–—~`\'"“”«»🎵🎶🎼]+', '', inner).lower()
            if (
                inner_stripped in _MUSIC_NOISE_TERMS
                or re.search(r'(?:' + _MUSIC_REGEX_KEYWORDS + r')', inner, flags=re.IGNORECASE)
            ):
                return True

    return False


def _strip_inline_music_tags(text: str) -> str:
    """Remove inline music / noise bracket tags from within dialogue sentences."""
    if not text:
        return ""
    # Strip bracketed tags containing music/noise keywords
    cleaned = re.sub(
        r'[\[\(（【「『《⟨\{]\s*[^\]\)）】」』》⟩\}]*?(?:' + _MUSIC_REGEX_KEYWORDS + r')[^\]\)）】」』》⟩\}]*?\s*[\]\)）】」』》⟩\}]',
        '',
        str(text),
        flags=re.IGNORECASE
    )
    # Strip isolated music emojis
    cleaned = re.sub(r'[🎵🎶🎼]', '', cleaned)
    return re.sub(r'\s+', ' ', cleaned).strip()


def _clean_repetitive_text(text: str) -> str:
    """Remove repetitive loop hallucinations (e.g. identical phrases repeated 3+ times)."""
    if not text:
        return ""
    t = text
    for _ in range(2):
        t = re.sub(r'([\u1780-\u17FF\u4E00-\u9FFF\w\s]{4,30}?)(?:\s*\1){2,}', r'\1', t)
        t = re.sub(r'(\b\S+\b(?:\s+\b\S+\b)?)(?:\s+\1){2,}', r'\1', t, flags=re.IGNORECASE)
    return t.strip()


def _parse_timestamp(val, prev_ref: float = 0.0) -> float:
    """Parse float seconds from numbers or timecode strings (e.g. 12.34, '01:23.4', '1:05', '100.90')."""
    if isinstance(val, (int, float)):
        raw_val = float(val)
    else:
        val_str = str(val).strip()
        if ":" in val_str:
            parts = val_str.split(":")
            try:
                if len(parts) == 2:
                    return float(parts[0]) * 60.0 + float(parts[1])
                elif len(parts) == 3:
                    return float(parts[0]) * 3600.0 + float(parts[1]) * 60.0 + float(parts[2])
            except (ValueError, TypeError):
                pass
        try:
            raw_val = float(val_str)
        except (ValueError, TypeError):
            return 0.0

    return round(raw_val, 2)


def _parse_segments(text: str) -> list:
    """Parse JSON segments from Gemini response text and ensure granular sentence-level splitting."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n?", "", text)
        text = re.sub(r"\n?```$", "", text)

    segments = _safe_json_loads(text)
    raw_cleaned = []
    minute_offset = 0.0
    prev_start = 0.0

    for i, seg in enumerate(segments):
        raw_vp = str(seg.get("voice_profile", "")).lower().strip()
        gender = str(seg.get("gender", "")).lower().strip()
        raw_spk = seg.get("speaker")
        if raw_spk and str(raw_spk).strip():
            speaker = str(raw_spk).strip()
        else:
            speaker = "Speaker"
        voice_profile = resolve_voice_profile(raw_vp, gender, speaker)

        seg_text = str(seg.get("text", "")).strip()
        orig_text = str(seg.get("original_text", "")).strip()

        # Remove speaker prefixes like "Speaker 1:"
        seg_text = re.sub(r"^(?:male|female|child|speaker\s*\d*)\s*:\s*", "", seg_text, flags=re.IGNORECASE).strip()
        orig_text = re.sub(r"^(?:male|female|child|speaker\s*\d*)\s*:\s*", "", orig_text, flags=re.IGNORECASE).strip()

        # Strip inline background music / sound effect tags
        seg_text = _strip_inline_music_tags(seg_text)
        orig_text = _strip_inline_music_tags(orig_text)

        # Discard segments that are purely background music or noise tags (e.g. [ភ្លេង], [តន្ត្រី], [Music])
        if _is_music_or_noise_segment(seg_text, orig_text):
            continue

        # Robust bidirectional fallback so neither text nor original_text is ever empty
        if not orig_text and seg_text:
            orig_text = seg_text
        if not seg_text and orig_text:
            seg_text = orig_text

        # If seg_text has both Khmer and Chinese characters mixed together (e.g. "唐伯虎 (តាំងប៉ហូ)" or "唐兄: បងថាង"),
        # clean the Chinese characters from the Khmer text field so it is 100% pure Khmer.
        if re.search(r'[\u1780-\u17FF]', seg_text) and re.search(r'[\u4E00-\u9FFF]', seg_text):
            cleaned_km = re.sub(r'[\u4E00-\u9FFF]+', '', seg_text)
            cleaned_km = re.sub(r'\(\s*\)|\[\s*\]', '', cleaned_km)
            cleaned_km = re.sub(r'^[:\s\-–—]+', '', cleaned_km).strip()
            if cleaned_km:
                seg_text = cleaned_km
            elif orig_text:
                seg_text = orig_text

        seg_text = _clean_repetitive_text(_clean_khmer_spacing(seg_text))
        if not seg_text and orig_text:
            seg_text = _clean_repetitive_text(orig_text)

        if not seg_text or _is_music_or_noise_segment(seg_text, orig_text):
            continue

        s_time = _parse_timestamp(seg.get("start_time", 0), prev_ref=prev_start)
        e_time = _parse_timestamp(seg.get("end_time", 0), prev_ref=s_time)

        # Intelligent duration clamping for single sentences (prevents subtitles stretching 40s across action/music)
        char_len = max(len(seg_text.strip()), len(orig_text.strip()))
        max_dur = max(2.0, min(char_len * 0.15 + 1.2, 5.0))
        if e_time <= s_time:
            e_time = round(s_time + min(max_dur, 3.5), 2)
        elif (e_time - s_time) > max_dur + 1.5:
            e_time = round(s_time + max_dur, 2)

        prev_start = s_time

        raw_cleaned.append({
            "index": len(raw_cleaned),
            "start_time": round(s_time, 2),
            "end_time": round(e_time, 2),
            "text": seg_text,
            "original_text": orig_text,
            "speaker": speaker,
            "voice_profile": voice_profile,
            "emotion": str(seg.get("emotion", "neutral")).lower().strip() or "neutral",
        })

    return split_overlong_segments(raw_cleaned)


# A caption longer than this cannot be read in the time it occupies, and dubbing it forces the
# voice to race. The model is asked for one sentence per segment but does not always comply,
# so any line that arrives over the limit is divided here before it reaches the timeline.
MAX_CAPTION_CHARS = 80
_SENTENCE_END = "។៕!?"


def _sentence_pieces(text: str, max_chars: int) -> list[str]:
    """Break a caption on sentence ends, then on phrase spaces, keeping pieces under max_chars."""
    text = (text or "").strip()
    if len(text) <= max_chars:
        return [text] if text else []

    # first pass: whole sentences
    sentences, current = [], ""
    for ch in text:
        current += ch
        if ch in _SENTENCE_END:
            sentences.append(current.strip())
            current = ""
    if current.strip():
        sentences.append(current.strip())

    pieces = []
    for sentence in sentences:
        if len(sentence) <= max_chars:
            pieces.append(sentence)
            continue
        # a single sentence still too long: break it at phrase spaces
        part = ""
        for word in re.split(r"(?<=[ \u200b])", sentence):
            if part and len(part) + len(word) > max_chars:
                pieces.append(part.strip())
                part = ""
            part += word
        if part.strip():
            pieces.append(part.strip())

    # Khmer does not space its words, so a long run can carry neither a sentence mark nor a
    # space. Rather than let it through, cut it on length — an even break beats an unreadable line.
    final = []
    for piece in pieces:
        while len(piece) > max_chars:
            final.append(piece[:max_chars].strip())
            piece = piece[max_chars:].strip()
        if piece:
            final.append(piece)
    return [p for p in final if p]


def split_overlong_segments(segments: list, max_chars: int = MAX_CAPTION_CHARS) -> list:
    """Divide captions carrying more text than one line can show.

    Each piece takes a share of the original segment's time proportional to its length, so the
    pieces together still cover exactly the stretch the speaker was talking.
    """
    out = []
    for seg in segments:
        text = (seg.get("text") or "").strip()
        pieces = _sentence_pieces(text, max_chars)
        if len(pieces) < 2:
            seg["index"] = len(out)
            out.append(seg)
            continue

        start = float(seg.get("start_time", 0.0))
        end = float(seg.get("end_time", start))
        span = max(0.4, end - start)
        total = sum(len(p) for p in pieces) or 1
        # The source dialogue rarely divides into the same number of pieces as the translation.
        # When it does, each piece keeps its own; when it does not, the whole original stays on
        # the first piece rather than being dropped — it is the record of what was actually said.
        whole_original = (seg.get("original_text") or "").strip()
        originals = _sentence_pieces(whole_original, max_chars)
        if len(originals) != len(pieces):
            originals = [whole_original]
        cursor = start
        for i, piece in enumerate(pieces):
            share = span * (len(piece) / total)
            piece_end = min(end, cursor + max(0.4, share))
            out.append({
                **seg,
                "index": len(out),
                "start_time": round(cursor, 2),
                "end_time": round(piece_end, 2),
                "text": piece,
                "original_text": originals[i] if i < len(originals) else "",
            })
            cursor = piece_end
    return out
