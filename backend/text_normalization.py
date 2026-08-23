from __future__ import annotations


REPLACEMENT_CHARACTER = "\ufffd"


def normalize_unicode_text(value: str) -> str:
    """Replace invalid UTF-16 surrogate code units without changing valid Unicode text."""
    if not any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        return value

    normalized: list[str] = []
    index = 0
    while index < len(value):
        codepoint = ord(value[index])
        if 0xD800 <= codepoint <= 0xDBFF:
            if index + 1 < len(value):
                low = ord(value[index + 1])
                if 0xDC00 <= low <= 0xDFFF:
                    normalized.append(chr(0x10000 + ((codepoint - 0xD800) << 10) + (low - 0xDC00)))
                    index += 2
                    continue
            normalized.append(REPLACEMENT_CHARACTER)
        elif 0xDC00 <= codepoint <= 0xDFFF:
            normalized.append(REPLACEMENT_CHARACTER)
        else:
            normalized.append(value[index])
        index += 1
    return "".join(normalized)
