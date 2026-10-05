"""Normalize detected voice metadata without overriding it with character names."""
import re


def resolve_voice_profile(profile=None, gender=None, speaker=None):
    aliases = {
        'male': 'male', 'female': 'female',
        'man': 'male', 'woman': 'female',
        'grandpa': 'grandpa', 'elderly_male': 'grandpa',
        'grandma': 'grandma', 'elderly_female': 'grandma',
        'boy': 'child_boy', 'child_boy': 'child_boy',
        'girl': 'child_girl', 'child_girl': 'child_girl',
        'child': 'child',
    }
    for value in (profile, gender):
        normalized = str(value or '').strip().lower().replace('-', '_').replace(' ', '_')
        if normalized in aliases:
            return aliases[normalized]

    label = str(speaker or '').strip().lower()
    # English labels require word boundaries: female != male, woman != man,
    # and a name such as Jackson is not a child merely because it contains son.
    labels = [
        ('grandma', r'\b(grandma|grandmother|elderly woman|old woman)\b', ('លោកយាយ', 'ជីដូន', '婆婆', '老奶奶')),
        ('grandpa', r'\b(grandpa|grandfather|elderly man|old man)\b', ('លោកតា', 'ជីតា', '老爷爷')),
        ('child_girl', r'\b(child girl|little girl|young girl|daughter)\b', ('ក្មេងស្រី', 'កូនស្រី', '女孩')),
        ('child_boy', r'\b(child boy|little boy|young boy|son)\b', ('ក្មេងប្រុស', 'កូនប្រុស', '男孩')),
        ('female', r'\b(female|woman|girl|mother|sister|wife|lady|waitress)\b', ('ស្រី', 'នារី', '女')),
        ('male', r'\b(male|man|boy|father|brother|husband)\b', ('ប្រុស', 'បុរស', '男')),
    ]
    for result, pattern, native_labels in labels:
        if re.search(pattern, label) or any(word in label for word in native_labels):
            return result
    return 'female'
