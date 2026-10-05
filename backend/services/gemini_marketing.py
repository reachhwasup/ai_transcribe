"""Titles, viral metadata packages and hooks."""
import re
import google.generativeai as genai
from backend.services.gemini_client import _generate_with_fallback, _get_active_keys
from backend.services.transcript_cleanup import _safe_json_loads


def _normalize_title_items(raw_data, original_title: str = "", language: str = "km") -> list[dict]:
    """Robustly normalize various JSON output formats from Gemini into standard title objects."""
    categories_meta = {
        "youtube_long": "ចំណងជើង YouTube កម្រិតខ្ពស់ & SEO (YouTube Standard)",
        "youtube_shorts": "YouTube Shorts ខ្លីខ្លឹម & Emojis",
        "viral_hook": "ចំណងជើងទាក់ទាញ (Viral Hook)",
        "comedy_nickname": "កំប្លុកកំប្លែង & ឈ្មោះតួអង្គ (Comedy)",
        "action_battle": "វាយប្រហារ & ក្បាច់គុន (Action & Battle)",
        "drama_mystery": "មនោសញ្ចេតនា & អាថ៌កំបាំង (Drama & Mystery)",
        "tiktok_short": "ខ្លីខ្លឹមបែប TikTok (TikTok / Reels Short)",
        "suspense": "រន្ធត់ & ភ្ញាក់ផ្អើល (Suspense)",
    }

    items = []
    if isinstance(raw_data, list):
        items = raw_data
    elif isinstance(raw_data, dict):
        if "titles" in raw_data and isinstance(raw_data["titles"], list):
            items = raw_data["titles"]
        elif "movie_titles" in raw_data and isinstance(raw_data["movie_titles"], list):
            items = raw_data["movie_titles"]
        elif "data" in raw_data and isinstance(raw_data["data"], list):
            items = raw_data["data"]
        elif "results" in raw_data and isinstance(raw_data["results"], list):
            items = raw_data["results"]
        else:
            for k, v in raw_data.items():
                if isinstance(v, str) and v.strip():
                    items.append({"category": k, "title": v.strip()})
                elif isinstance(v, dict) and "title" in v:
                    items.append(v)
                elif isinstance(v, list):
                    for sub in v:
                        if isinstance(sub, (str, dict)):
                            items.append(sub)

    normalized = []
    cat_keys = list(categories_meta.keys())
    for i, it in enumerate(items):
        if isinstance(it, str) and it.strip():
            cat = cat_keys[i % len(cat_keys)]
            normalized.append({
                "category": cat,
                "category_label": categories_meta.get(cat, "ចំណងជើងទាក់ទាញ"),
                "title": it.strip(),
                "description": "ចំណងជើងទាក់ទាញបង្កើតការចង់ដឹងចង់ឃើញខ្ពស់"
            })
        elif isinstance(it, dict):
            title = it.get("title") or it.get("text") or it.get("headline") or it.get("name") or ""
            if not title or not str(title).strip():
                continue
            cat = str(it.get("category") or cat_keys[i % len(cat_keys)]).strip()
            cat_label = str(it.get("category_label") or categories_meta.get(cat) or cat).strip()
            desc = str(it.get("description") or it.get("reason") or "ចំណងជើងទាក់ទាញសម្រាប់ការចែករំលែក").strip()
            normalized.append({
                "category": cat,
                "category_label": cat_label,
                "title": str(title).strip(),
                "description": desc
            })

    if normalized:
        return normalized

    # Contextual Fallback if no valid titles parsed
    is_ph = (
        not original_title
        or len(original_title.strip()) <= 2
        or original_title.strip().lower() in ["untitled", "project", "new", "video", "test", "demo", "untitled video"]
        or bool(re.match(r'^(project\s*[a-z0-9]?|new\s*project|untitled(\s*\d+)?|[a-z])$', original_title.strip(), re.I))
    )
    topic = "ភាពយន្តពេញ" if is_ph else original_title.strip()
    if language in ("km", "auto", ""):
        return [
            {
                "category": "youtube_long",
                "category_label": "ចំណងជើង YouTube ស្តង់ដារ & SEO",
                "title": f"សម្រាយរឿង {topic} ភាគបញ្ចប់ | ឈុតឆាកជក់ចិត្តពីដើមដល់ចប់ (Full Movie Recap)",
                "description": "ចំណងជើងស្តង់ដារ YouTube Long-form មានពាក្យគន្លឹះ SEO ពេញលេញ បង្កើនការស្វែងរក"
            },
            {
                "category": "viral_hook",
                "category_label": "ចំណងជើងទាក់ទាញ (Viral Headline)",
                "title": f"សម្រាយរឿង៖ {topic} - ការពិតដ៏រន្ធត់ដែលលាក់ទុកអស់ជាច្រើនឆ្នាំ!",
                "description": "ចំណងជើងបែបភ្ញាក់ផ្អើល បង្កើតការចង់ដឹងចង់ឃើញខ្ពស់ និងជំរុញឱ្យចុចទស្សនាភ្លាមៗ"
            },
            {
                "category": "action_battle",
                "category_label": "ចំណងជើងបែបវាយប្រហារ & ក្បាច់គុន",
                "title": f"កំពូលក្បាច់គុនកក្រើកពិភពគុណ | សម្រាយរឿង {topic} ភាគបញ្ចប់",
                "description": "ចំណងជើងបែបវាយប្រហារ ក្បាច់គុន និងសកម្មភាពប្រយុទ្ធស្វិតស្វាញ"
            },
            {
                "category": "comedy_nickname",
                "category_label": "ចំណងជើងបែបកំប្លែង & សម្មតិនាមតួអង្គ",
                "title": f"អាប្រុសខូចប៉ះស្រីស្អាតចិត្តដាច់ | សម្រាយរឿងកំប្លែង {topic}",
                "description": "ចំណងជើងបែបកំប្លែង សើចសប្បាយ ប្រើសម្មតិនាមតួអង្គទាក់ទាញ"
            },
            {
                "category": "drama_mystery",
                "category_label": "ចំណងជើងបែបអាថ៌កំបាំង & មនោសញ្ចេតនា",
                "title": f"រឿង៖ {topic} - ការក្បត់ដែលនឹកស្មានមិនដល់ និងការលះបង់ដ៏ធំធេង",
                "description": "ចំណងជើងបែបអាថ៌កំបាំង រឿងរ៉ាវពិត និងមនោសញ្ចេតនាជ្រាលជ្រៅ"
            },
            {
                "category": "facebook_post",
                "category_label": "ចំណងជើង Facebook Watch & Reels",
                "title": f"🔥 {topic} ភាគបញ្ចប់ | ឈុតឆាកកក្រើកដែលកំពុងផ្ទុះការគាំទ្រខ្លាំងលើ Facebook 🎬",
                "description": "ចំណងជើងស្តង់ដារ Facebook Watch និង Facebook Reels មាន Emojis ទាក់ទាញ"
            },
            {
                "category": "youtube_shorts",
                "category_label": "ចំណងជើង YouTube Shorts & TikTok",
                "title": f"សម្រាយរឿងខ្លី | {topic} ភាគ១ #shorts #movierecap",
                "description": "ចំណងជើងខ្លីខ្លឹម ស័ក្តិសមសម្រាប់ YouTube Shorts និង TikTok"
            },
            {
                "category": "suspense",
                "category_label": "ចំណងជើងបែបតក់ស្លុត & Climax",
                "title": f"វិនាទីចុងក្រោយដែលគ្មានអ្នកណាដឹង! | សម្រាយរឿង {topic}",
                "description": "ចំណងជើងបែបតក់ស្លុត និងទាក់ទាញការចែករំលែកខ្ពស់"
            }
        ]
    else:
        return [
            {
                "category": "youtube_long",
                "category_label": "YouTube Standard & SEO",
                "title": f"{topic} Full Movie Recap & Ending Explained (2024)",
                "description": "High-CTR search-optimized YouTube video headline"
            },
            {
                "category": "facebook_post",
                "category_label": "Facebook Watch & Reels",
                "title": f"🔥 {topic} - The full breakdown everyone is talking about! 🎬",
                "description": "Engaging Facebook video post headline"
            },
            {
                "category": "viral_hook",
                "category_label": "Viral Headline",
                "title": f"The Dark Secret Behind {topic} That Everyone Missed!",
                "description": "High-suspense curiosity gap video title"
            },
            {
                "category": "action_battle",
                "category_label": "Action & Climax",
                "title": f"Ultimate Battle & Climax | {topic} Full Breakdown",
                "description": "Action-packed, adrenaline-filled headline"
            },
            {
                "category": "youtube_shorts",
                "category_label": "YouTube Shorts",
                "title": f"{topic} Best Scene Recap #shorts #movierecap",
                "description": "Punchy short-form title optimized for Shorts and Reels"
            }
        ]


async def generate_movie_titles(
    original_title: str = "",
    transcript_text: str = "",
    video_path: str = "",
    language: str = "km",
) -> list[dict]:
    """Generate viral, high-CTR movie recap titles in multiple popular styles."""
    is_ph = (
        not original_title
        or len(original_title.strip()) <= 2
        or original_title.strip().lower() in ["untitled", "project", "new", "video", "test", "demo", "untitled video"]
        or bool(re.match(r'^(project\s*[a-z0-9]?|new\s*project|untitled(\s*\d+)?|[a-z])$', original_title.strip(), re.I))
    )
    title_inst = (
        "CRITICAL: The user's input title is a generic placeholder letter/code (e.g. 'N'). You MUST infer the TRUE dramatic Cambodian movie title, character names, and core story conflict directly from the dialogue transcript. NEVER output the letter 'N' as the movie title."
        if is_ph
        else f"Story Title / Reference Topic: {original_title}"
    )

    prompt = f"""You are an elite Cambodian movie recap copywriter and YouTube viral title strategist.

Target Language: {language} (use authentic Cambodian Khmer for 'km', or English for 'en').
{title_inst}

Dialogue Transcript:
{transcript_text[:6500] if transcript_text else 'No dialogue available'}

CRITICAL INSTRUCTIONS FOR ACCURACY & HIGH CTR:
1. Extract the actual character names mentioned in the dialogue (e.g. គូយានសិន Gu Yanshen, ថាងស៊ាវជាវ Tang Xiaojiao, សិនអៅ Shen Ao, etc.).
2. Identify the specific conflict and drama from the scene (e.g. ex-Wall Street billionaire disguised as stay-at-home husband/nanny, young master Shen Ao of Northern Jingwu clan looking down on him, hotpot wife defending husband).
3. EVERY generated title MUST be accurate to this specific scene and mention the real character names or their specific roles.
4. DO NOT output generic placeholders.

Return ONLY a valid JSON array of 9 objects matching this exact schema:
[
  {{
    "category": "youtube_long",
    "category_label": "🎬 ចំណងជើង YouTube ស្តង់ដារ & SEO",
    "title": "សម្រាយរឿងពេញ៖ មហាសេដ្ឋីលាក់អត្តសញ្ញាណ គូយានសិន និង ថាងស៊ាវជាវ | ភាគបញ្ចប់",
    "description": "ចំណងជើងស្តង់ដារ YouTube Long-form មានពាក្យគន្លឹះ SEO ពេញលេញ"
  }},
  {{
    "category": "facebook_post",
    "category_label": "🔥 ចំណងជើង Facebook Watch & Reels",
    "title": "🔥 ថាងស៊ាវជាវ ចេញមុខការពារប្តី គូយានសិន បកស្បែក សិនអៅ កណ្តាលភូមិគ្រឹះ 🎬",
    "description": "ចំណងជើង Facebook Watch និង Reels ទាក់ទាញការចែករំលែក"
  }},
  {{
    "category": "viral_hook",
    "category_label": "💥 ចំណងជើងទាក់ទាញ (Viral Story Hook)",
    "title": "មហាសេដ្ឋី គូយានសិន លាក់ខ្លួនធ្វើប៉ាគេងផ្ទះ ត្រូវ សិនអៅ មើលងាយពេក ថាងស៊ាវជាវ ទ្រាំលែងបាន!",
    "description": "ចំណងជើងទាក់ទាញបង្កើតការចង់ដឹងចង់ឃើញខ្ពស់ ផ្អែកលើតួអង្គពិត"
  }},
  {{
    "category": "power_reversal",
    "category_label": "⚡ លាតត្រដាងអំណាចពិត (Identity Reveal)",
    "title": "ភ្ញាក់ព្រើត! អ្នកដែល សិនអៅ មើលងាយថាជា 'ប្រុសស៊ីបាយកក' នោះ គឺជាស្តេច Wall Street គូយានសិន!",
    "description": "ចំណងជើងបែបភ្ញាក់ផ្អើល បកស្បែកតួអង្គអំនួត"
  }},
  {{
    "category": "action_battle",
    "category_label": "⚔️ ចំណងជើងបែបវាយប្រហារ & ក្បាច់គុន",
    "title": "ហ៊ាននាំមនុស្សមកវាយកម្ទេចភូមិគ្រឹះត្រកូលគូ! ថាងស៊ាវជាវ បញ្ជាសន្តិសុខវាយបកវិញគ្មានប្រណី!",
    "description": "ចំណងជើងបែបវាយប្រហារ កម្លាំងបក្សពួក និងសកម្មភាពប្រយុទ្ធស្វិតស្វាញ"
  }},
  {{
    "category": "comedy_nickname",
    "category_label": "😂 ចំណងជើងបែបកំប្លែង & សម្មតិនាមតួអង្គ",
    "title": "អាប្រុសអំនួតប៉ះប្រពន្ធឆ្នាស! សិនអៅ ត្រូវទឹកលាងកន្ទបកូនលាងខួរក្បាលរត់បះសក់!",
    "description": "ចំណងជើងបែបកំប្លែង សើចសប្បាយ ប្រើសម្មតិនាមតួអង្គទាក់ទាញ"
  }},
  {{
    "category": "drama_mystery",
    "category_label": "🎭 ចំណងជើងបែបអាថ៌កំបាំង & មនោសញ្ចេតនា",
    "title": "រឿង៖ គូយានសិន និង ថាងស៊ាវជាវ - ការពិតនៅពីក្រោយប្តីស៊ីបាយកកដែលលះបង់ដើម្បីគ្រួសារ",
    "description": "ចំណងជើងបែបអាថ៌កំបាំង រឿងរ៉ាវពិត និងមនោសញ្ចេតនាជ្រាលជ្រៅ"
  }},
  {{
    "category": "youtube_shorts",
    "category_label": "📱 ចំណងជើង YouTube Shorts & TikTok",
    "title": "សម្រាយរឿងខ្លី | ថាងស៊ាវជាវ ការពារប្តីមហាសេដ្ឋី គូយានសិន #shorts #movierecap",
    "description": "ចំណងជើងខ្លីខ្លឹម ស័ក្តិសមសម្រាប់ YouTube Shorts និង TikTok"
  }},
  {{
    "category": "suspense",
    "category_label": "😱 ចំណងជើងបែបតក់ស្លុត & Climax",
    "title": "វិនាទីចុងក្រោយដែលគ្មានអ្នកណាដឹង! គូយានសិន ទម្លាយអត្តសញ្ញាណពិតកម្ទេចត្រកូលសិន!",
    "description": "ចំណងជើងបែបតក់ស្លុត និងទាក់ទាញការចែករំលែកខ្ពស់"
  }}
]"""

    try:
        response = await _generate_with_fallback(
            prompt,
            generation_config=genai.types.GenerationConfig(
                temperature=0.85,
                response_mime_type="application/json",
            )
        )
        if response and response.text:
            text = response.text.strip()
            if text.startswith("```"):
                text = re.sub(r"^```(?:json)?\n?", "", text)
                text = re.sub(r"\n?```$", "", text)
            parsed = _safe_json_loads(text)
            titles = _normalize_title_items(parsed, original_title=original_title, language=language)
            if titles:
                return titles
    except Exception as e:
        print(f"[generate_movie_titles] Gemini call failed: {e}", flush=True)

    return _normalize_title_items(None, original_title=original_title, language=language)


HOOK_MAX_SECONDS = 30.0          # past this it is a narration, not a hook — use Movie Recap
HOOK_CHARS_PER_SECOND = 15.0     # what a Khmer narrator says in a second
HOOK_TRANSCRIPT_CHARS = 14000    # a longer hook needs more of the story to draw on
HOOK_RETRY_BELOW = 0.6           # a long hook under this share of its length is asked for again


async def generate_catchy_hooks(
    original_title: str,
    transcript_text: str,
    language: str = "km",
    duration_seconds: float = 4.0,
    tone: str = "viral",
    video_path: str = "",
    **kwargs,
) -> list[dict]:
    """Generate high-retention viral opening hook scripts (3–30s) before starting a video."""
    dur = max(2.0, min(float(duration_seconds or 4.0), HOOK_MAX_SECONDS))
    target_chars = int(dur * HOOK_CHARS_PER_SECOND)

    if dur <= 3.5:
        length_guide = f"Target length: ~{dur:.1f}s (1 short, ultra-punchy sentence, around 8 to 12 Khmer words)."
    elif dur <= 5.0:
        length_guide = f"Target length: ~{dur:.1f}s (1 to 2 suspenseful sentences, around 14 to 20 Khmer words)."
    elif dur <= 7.0:
        length_guide = f"Target length: ~{dur:.1f}s (2 dramatic narrative sentences, around 22 to 30 Khmer words)."
    elif dur <= 10.0:
        length_guide = f"Target length: ~{dur:.1f}s (2 to 3 substantial, detailed narrative sentences, around 35 to 55 Khmer words setting up the secret identity, stakes, and confrontation)."
    else:
        # A long hook is a short narrated opening, not one stretched sentence: it needs several
        # lines, each doing a different job, or the narrator runs out of things to say.
        sentences = max(4, round(dur / 3.2))
        length_guide = (
            f"Target length: ~{dur:.0f}s of narration — {sentences - 1} to {sentences + 1} sentences, "
            f"about {int(dur * 4)} to {int(dur * 5.5)} Khmer words, at least {target_chars} characters.\n"
            "Write it as a sequence of short lines, each its own beat, in this order:\n"
            "  1. the grabber — a question or a shock that stops the scroll\n"
            "  2. who this is about, by name, and what everyone believes about them\n"
            "  3. the truth or the secret the others do not know\n"
            "  4. the conflict that is about to break, and who starts it\n"
            "  5. what is at stake if it goes wrong\n"
            "  6. the cliffhanger — a promise of the payoff, without giving it away\n"
            "Each sentence must add something new from the transcript; do not repeat an idea to fill time."
        )

    is_ph = (
        not original_title
        or len(original_title.strip()) <= 2
        or original_title.strip().lower() in ["untitled", "project", "new", "video", "test", "demo", "untitled video"]
        or bool(re.match(r'^(project\s*[a-z0-9]?|new\s*project|untitled(\s*\d+)?|[a-z])$', original_title.strip(), re.I))
    )
    title_inst = (
        "CRITICAL: The title is a placeholder code. Take the character names and the plot from the dialogue itself; do not use names that are not in it."
        if is_ph
        else f"Story Reference: {original_title}"
    )

    prompt = f"""You are Cambodia's #1 viral movie recap narrator (អ្នកសម្រាយរឿងភាពយន្តដ៏ល្បី) and short-form video copywriter.
Create 6 distinct, high-CTR, cinematic spoken opening voiceover hooks (អត្ថបទសំឡេងបើកក្បាលរឿងទាក់ទាញអារម្មណ៍) for Facebook Watch, TikTok, and YouTube.

{title_inst}
Language: {language} (Authentic spoken Cambodian Khmer script / ភាសានិយាយសម្រាយរឿងខ្មែរ 100% pure script)
Tone: {tone}
{length_guide}

Dialogue Transcript:
{transcript_text[:HOOK_TRANSCRIPT_CHARS if dur > 10 else 5000] if transcript_text else 'Exciting movie scene'}

CRITICAL KHMER RECAP WRITING RULES:
1. TARGET DURATION PACING ({dur:.1f}s):
   - Match the required spoken duration: about {target_chars} Khmer characters, which is what a narrator says in {dur:.0f} seconds. A hook that comes up short leaves the opening playing in silence.
   - End every sentence with ។ ! or ? so it can be shown line by line.
2. 100% NATURAL SPOKEN KHMER RECAP DICTION:
   - Use vibrant storytelling phrases: "អ្នកណាទៅដឹងថា...", "មើលងាយគេថា...", "គិតថាលោកម្ចាស់ម្នាក់នេះស្លូតមែនទេ?", "ហ៊ាននាំមនុស្សមកកម្ទេចដល់ផ្ទះ...", "គ្រាន់តែ...សោះ ហ៊ាន...", "ចាំមើលគេបង្រៀនមេរៀនយ៉ាងណា!"
   - NEVER include Chinese Hanzi characters (e.g. 乜, 吗), English words, or bracketed notes in the hook text.
3. GROUNDED IN TRUE CHARACTER NAMES & CONFLICT:
   - Use the real character names, relationships, and conflict extracted from the dialogue transcript.

Generate a JSON array with 6 distinct hook variations:
[
  {{
    "hook_id": "hook_1",
    "category": "movie_recap",
    "category_label": "🎬 Movie Recap Narrator",
    "text": "...",
    "estimated_seconds": {dur:.1f},
    "why_it_works": "Classic cinematic storytelling hook establishing the hidden master archetype."
  }},
  {{
    "hook_id": "hook_2",
    "category": "power_reversal",
    "category_label": "⚡ Identity Reveal & Karma",
    "text": "...",
    "estimated_seconds": {dur:.1f},
    "why_it_works": "Reveals the shocking hidden identity and impending retribution."
  }},
  {{
    "hook_id": "hook_3",
    "category": "viral_curiosity",
    "category_label": "🔥 Viral Curiosity Question",
    "text": "...",
    "estimated_seconds": {dur:.1f},
    "why_it_works": "Piques immediate curiosity with an irresistible hook question."
  }},
  {{
    "hook_id": "hook_4",
    "category": "action_conflict",
    "category_label": "💥 Action & Combat Climax",
    "text": "...",
    "estimated_seconds": {dur:.1f},
    "why_it_works": "High energy tension and explosive confrontation."
  }},
  {{
    "hook_id": "hook_5",
    "category": "savage_attitude",
    "category_label": "👑 Savage Attitude & Power",
    "text": "...",
    "estimated_seconds": {dur:.1f},
    "why_it_works": "Unapologetic fierce dialogue establishing dominant authority."
  }},
  {{
    "hook_id": "hook_6",
    "category": "cliffhanger",
    "category_label": "😱 Shocking Cliffhanger",
    "text": "...",
    "estimated_seconds": {dur:.1f},
    "why_it_works": "Immediate cliffhanger that stops scrolling and maximizes retention."
  }}
]
Return ONLY the raw JSON array."""

    async def ask(text_prompt: str) -> list[dict]:
        response = await _generate_with_fallback(text_prompt)
        if not (response and response.text):
            return []
        text = response.text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\n?", "", text)
            text = re.sub(r"\n?```$", "", text)
        data = _safe_json_loads(text)
        if not isinstance(data, list):
            return []
        hooks = []
        for item in data:
            if not isinstance(item, dict) or not isinstance(item.get("text"), str):
                continue
            cleaned = item["text"]
            # Replace common Thai script leaks into Khmer
            cleaned = cleaned.replace("យอม", "ព្រម").replace("ยอม", "ព្រម")
            # Clean any stray non-Khmer / foreign scripts (Chinese Hanzi, Thai, etc.)
            cleaned = re.sub(r'[\u4e00-\u9fff\u3400-\u4dbf\u0e00-\u0e7f]', '', cleaned)
            item["text"] = re.sub(r'\s+', ' ', cleaned).strip()
            if item["text"]:
                hooks.append(item)
        return hooks

    def typical_length(hooks: list[dict]) -> int:
        lengths = sorted(len(h["text"]) for h in hooks)
        return lengths[len(lengths) // 2] if lengths else 0

    try:
        hooks = await ask(prompt)
        # A long hook that comes back at the length of a short one is asked for again, with its
        # own length quoted; whichever set is fuller is kept.
        if hooks and dur > 10 and typical_length(hooks) < target_chars * HOOK_RETRY_BELOW:
            try:
                longer = await ask(
                    f"PREVIOUS ATTEMPT WAS TOO SHORT: the hooks were about {typical_length(hooks)} characters "
                    f"and each must be at least {target_chars}, to fill {dur:.0f} seconds of narration. "
                    f"Write all six again at full length, following the beats in order.\n\n" + prompt
                )
                if typical_length(longer) > typical_length(hooks):
                    hooks = longer
            except Exception as e:
                print(f"Hook expansion skipped: {e}", flush=True)
        if hooks:
            for item in hooks:
                # how long this text really takes to say, so the timeline gives it that much room
                item["estimated_seconds"] = (
                    round(min(HOOK_MAX_SECONDS + 10, max(dur * 0.6, len(item["text"]) / HOOK_CHARS_PER_SECOND)), 1)
                    if dur > 10 else dur
                )
                item["lines"] = len([part for part in re.split(r"[។!?]+", item["text"]) if part.strip()])
            return hooks
    except Exception as e:
        print(f"Error generating catchy hooks: {e}", flush=True)

    # Dynamic duration-aware fallback hooks
    if dur >= 8.0:
        return [
            {
                "hook_id": "hook_1",
                "category": "movie_recap",
                "category_label": f"🎬 Movie Recap Narrator ({dur:.0f}s)",
                "text": "អ្នកណាទៅដឹងថា បុរសដែលគេមើលងាយថាជាមេដោះប្រុសស៊ីបាយកកនៅផ្ទះ តាមពិតគឺជាមហាសេដ្ឋីលំដាប់កំពូលលាក់មុខ! ពេលនេះពួកសត្រូវហ៊ានសម្រុកចូលដល់ភូមិគ្រឹះ ចាំមើលថាតើពួកគេនឹងត្រូវបាក់មុខយ៉ាងណា!",
                "estimated_seconds": dur,
                "why_it_works": "Substantial 10s opening establishing identity and confrontation."
            },
            {
                "hook_id": "hook_2",
                "category": "power_reversal",
                "category_label": f"⚡ Identity Reveal & Karma ({dur:.0f}s)",
                "text": "ស្មានតែប្រុសកំសាកងាយនឹងជាន់ឈ្លី! មិនដឹងថាគេជាកំពូលស្តេចសេចក្តីស្លាប់នៅ Wall Street ឡើយ! ថ្ងៃនេះត្រូវប្រពន្ធចេញមុខជះទឹកលាងកន្ទបកូនដាក់មុខបំបាក់សត្រូវឱ្យផ្អើលពេញភូមិគ្រឹះ!",
                "estimated_seconds": dur,
                "why_it_works": "Shocking identity reveal and explosive dramatic karma."
            },
            {
                "hook_id": "hook_3",
                "category": "viral_curiosity",
                "category_label": f"🔥 Viral Curiosity ({dur:.0f}s)",
                "text": "តើអ្នកធ្លាប់ឃើញប្រុសមេដោះណាដែលធ្វើឱ្យបក្សម៉ាហ្វីយ៉ាទាំងមូលញ័រជើងទេ? មើលដល់ចប់ទើបដឹងថា ហេតុអ្វីបានជាគ្មានអ្នកណាហ៊ានប៉ះពាល់ប្រពន្ធ និងកូនរបស់គេ!",
                "estimated_seconds": dur,
                "why_it_works": "Intriguing question hook guaranteeing maximum watch time."
            },
            {
                "hook_id": "hook_4",
                "category": "action_conflict",
                "category_label": f"💥 Action & Combat Climax ({dur:.0f}s)",
                "text": "គ្រាន់តែទឹកដោះគោកូនក្តៅលើស ០.៥ អង្សាសេ គេហ៊ានវាយបំបាក់មនុស្សរាប់សិបនាក់! សម្រុកចូលដល់ភូមិគ្រឹះចង់សម្លាប់គេ ធានាថាមើលចប់មិនខកបំណងទេ!",
                "estimated_seconds": dur,
                "why_it_works": "Fierce protective drama and high-stakes confrontation."
            }
        ]
    elif dur >= 5.5:
        return [
            {
                "hook_id": "hook_1",
                "category": "curiosity_gap",
                "category_label": f"🔥 Viral Mystery Hook ({dur:.0f}s)",
                "text": "មើលងាយគេថាជាប្រុសស៊ីបាយកក មិនដឹងថាគេជាកំពូលមហាសេដ្ឋីលាក់មុខ! ឈុតឆាកបាក់មុខដ៏កក្រើកបានចាប់ផ្តើមហើយ!",
                "estimated_seconds": dur,
                "why_it_works": "6-8s dramatic tension."
            },
            {
                "hook_id": "hook_2",
                "category": "action_shock",
                "category_label": f"⚡ Action Shock ({dur:.0f}s)",
                "text": "ហ៊ានចូលមកអុកឡុកដល់ផ្ទះ! ប្រពន្ធចេញមុខការពារប្តី ជះទឹកដាក់មុខសត្រូវឱ្យដឹងដៃម្តង!",
                "estimated_seconds": dur,
                "why_it_works": "Direct character action."
            }
        ]
    else:
        return [
            {
                "hook_id": "hook_1",
                "category": "curiosity_gap",
                "category_label": "🔥 Viral Mystery Hook",
                "text": "អ្នកណាស្មានដល់ថា បុរសម្នាក់នេះជាមហាសេដ្ឋីលាក់មុខ!",
                "estimated_seconds": dur,
                "why_it_works": "Short punchy 3-4s hook."
            },
            {
                "hook_id": "hook_2",
                "category": "action_shock",
                "category_label": "⚡ Action Shock",
                "text": "ហ៊ានមើលងាយប្តីខ្ញុំ លើកនេះដឹងតែចប់ហើយ!",
                "estimated_seconds": dur,
                "why_it_works": "Fierce 3-4s punch."
            }
        ]
