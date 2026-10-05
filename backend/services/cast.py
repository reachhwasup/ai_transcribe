"""One gender per character.

The voice a line is dubbed in comes from its `voice_profile`, which the transcriber guesses
line by line from the audio. Nothing held a character to one answer, so the same man could be
tagged male on one line and female on the next and was dubbed in two voices. This decides each
named character once — from their name, how the others address them, what they say, and the
per-line guesses — and applies it to all of their lines.
"""
from __future__ import annotations

import re
from collections import Counter

MALE_PROFILES = {"male", "grandpa", "child_boy"}
FEMALE_PROFILES = {"female", "grandma", "child_girl", "child"}
_AGE_OF = {"male": "adult", "female": "adult", "grandpa": "elderly", "grandma": "elderly",
           "child_boy": "child", "child_girl": "child", "child": "child"}
_PROFILE_FOR = {
    ("male", "adult"): "male", ("male", "elderly"): "grandpa", ("male", "child"): "child_boy",
    ("female", "adult"): "female", ("female", "elderly"): "grandma", ("female", "child"): "child_girl",
}
CAST_MAX_CHARS = 40000       # dialogue sent to decide the cast
MIN_LINES_FOR_AI = 6         # below this there is nothing to reconcile worth a request


def family(profile: str | None) -> str:
    return "male" if (profile or "").lower() in MALE_PROFILES else "female"


def _named(speaker: str | None) -> str | None:
    # the labels the app itself hands out ("តួអង្គប្រុស (Male)") are a kind of voice, not a person
    from backend.api.routes.timeline_sync import _named_speaker
    return _named_speaker(speaker)


def tally(lines: list[dict]) -> dict[str, Counter]:
    """Per named character, how many lines carry each profile."""
    counts: dict[str, Counter] = {}
    for line in lines:
        name = _named(line.get("speaker"))
        if name:
            counts.setdefault(name, Counter())[(line.get("voice_profile") or "female").lower()] += 1
    return counts


def choose_profile(profiles: Counter, gender: str = "", age: str = "") -> str:
    """The one profile for a character: the decided gender (else the majority of their lines),
    at the age most of their lines in that gender already have."""
    by_family = Counter()
    for profile, n in profiles.items():
        by_family[family(profile)] += n
    if gender not in ("male", "female"):
        # a tie stays with whatever the first line said, so nothing flips without a reason
        top = by_family.most_common()
        gender = top[0][0] if len(top) == 1 or top[0][1] != top[1][1] else family(next(iter(profiles)))
    ages = Counter()
    for profile, n in profiles.items():
        if family(profile) == gender:
            ages[_AGE_OF.get(profile, "adult")] += n
    chosen_age = ages.most_common(1)[0][0] if ages else (age if age in ("adult", "elderly", "child") else "adult")
    return _PROFILE_FOR[(gender, chosen_age)]


async def ask_cast(lines: list[dict]) -> dict[str, dict]:
    """Ask the model who each named character is. {} when it cannot be asked or answered."""
    counts = tally(lines)
    if not counts or sum(sum(c.values()) for c in counts.values()) < MIN_LINES_FOR_AI:
        return {}
    import google.generativeai as genai
    from backend.services.gemini_client import _configure_genai, _generate_with_fallback
    from backend.services.transcript_cleanup import _safe_json_loads

    heard = {"male": "man", "female": "woman", "grandpa": "old man", "grandma": "old woman",
             "child_boy": "boy", "child_girl": "girl", "child": "child"}
    dialogue = [
        f"[{(l.get('speaker') or '?').strip()} | heard: {heard.get((l.get('voice_profile') or '').lower(), '?')}] "
        f"{(l.get('original_text') or l.get('text') or '').strip()}"
        for l in lines if (l.get("original_text") or l.get("text") or "").strip()
    ]
    text = "\n".join(dialogue)
    if len(text) > CAST_MAX_CHARS:
        step = len(text) / CAST_MAX_CHARS
        text = "\n".join(dialogue[int(i * step)] for i in range(int(len(dialogue) / step)))
    roster = "\n".join(
        f"- {name}: heard as a man on {sum(n for p, n in c.items() if family(p) == 'male')} lines, "
        f"as a woman on {sum(n for p, n in c.items() if family(p) == 'female')}"
        for name, c in counts.items()
    )
    prompt = f"""Below is the dialogue of a film. Each line is "[speaker | heard: …] text".
The "heard" tag was guessed line by line from the audio and is often wrong — it even flips for the
same person from one line to the next. Decide, once, who each of these characters is:

{roster}

Use everything: the name itself, how the others address or refer to them (he/she, Mr/Miss, brother,
sister, mother, 他/她, 先生, 小姐, 哥, 姐…), what they say about themselves, and the heard tags as
weak evidence. Answer "unknown" rather than guess when the dialogue gives no real indication.

Return JSON only:
{{"characters": [{{"name": "exactly as listed above", "gender": "male" | "female" | "unknown", "age": "adult" | "elderly" | "child"}}]}}

Dialogue:
{text}"""
    try:
        await _configure_genai()
        response = await _generate_with_fallback(
            prompt,
            generation_config=genai.types.GenerationConfig(temperature=0.0, response_mime_type="application/json"),
        )
        raw = re.sub(r"^```(?:json)?\n?|\n?```$", "", response.text.strip())
        parsed = _safe_json_loads(raw)
    except Exception as exc:
        print(f"[cast] could not ask who the characters are: {type(exc).__name__}", flush=True)
        return {}
    out = {}
    for item in (parsed.get("characters") if isinstance(parsed, dict) else None) or []:
        if isinstance(item, dict) and str(item.get("name") or "").strip() in counts:
            out[str(item["name"]).strip()] = {
                "gender": str(item.get("gender") or "").lower(), "age": str(item.get("age") or "").lower(),
            }
    return out


async def decide_cast(lines: list[dict], use_ai: bool = True) -> dict[str, dict]:
    """{character: {"profile", "decided_by", "male_lines", "female_lines"}} for every named
    character. Falls back to the majority of each character's own lines when the model cannot
    be asked or does not know."""
    counts = tally(lines)
    answers = await ask_cast(lines) if use_ai else {}
    cast = {}
    for name, profiles in counts.items():
        answer = answers.get(name, {})
        known = answer.get("gender") in ("male", "female")
        cast[name] = {
            "profile": choose_profile(profiles, answer.get("gender", ""), answer.get("age", "")),
            "decided_by": "dialogue" if known else "majority",
            "male_lines": sum(n for p, n in profiles.items() if family(p) == "male"),
            "female_lines": sum(n for p, n in profiles.items() if family(p) == "female"),
        }
    return cast


def apply_cast_to_dicts(lines: list[dict], cast: dict[str, dict]) -> int:
    """Set every named character's lines to their one profile. Returns how many changed."""
    changed = 0
    for line in lines:
        decided = cast.get(_named(line.get("speaker")) or "")
        if decided and (line.get("voice_profile") or "").lower() != decided["profile"]:
            line["voice_profile"] = decided["profile"]
            line["gender"] = family(decided["profile"])
            line.pop("voice_name", None)     # re-chosen from the profile
            changed += 1
    return changed


def apply_cast_to_segments(segments: list, cast: dict[str, dict]) -> tuple[int, int]:
    """The same for stored captions. A line that changes gets the built-in voice for its new
    profile and loses its dub, which was spoken in the wrong voice; a line using a captured or
    saved voice keeps that voice and its audio — that was a deliberate choice.
    Returns (lines changed, dubs cleared)."""
    from backend.services.tts_service import DEFAULT_VOICE_MAP, KHMER_FEMALE, KHMER_MALE

    built_in = {"", KHMER_FEMALE, KHMER_MALE}
    changed = cleared = 0
    for seg in segments:
        decided = cast.get(_named(seg.speaker) or "")
        if not decided or (seg.voice_profile or "female").lower() == decided["profile"]:
            continue
        seg.voice_profile = decided["profile"]
        changed += 1
        if (seg.voice_name or "") in built_in:
            seg.voice_name = DEFAULT_VOICE_MAP.get(decided["profile"], KHMER_FEMALE)
            if seg.audio_url:
                seg.audio_url = ""
                cleared += 1
    return changed, cleared
