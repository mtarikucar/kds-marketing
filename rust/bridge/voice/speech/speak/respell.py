"""Brand respelling in front of the normaliser: a written brand becomes the spelling the voice
pronounces right ("Jeeta" -> "Cita"). EMA Lightning reads foreign words by Turkish spelling (its
model card), and Antalia's normaliser keeps these brands as written (its lexicon is reviewed for
its own voice): without the table EMA's model would receive "jeeta", "whatsapp", "facebook" and
"google" (checked with antalia-mini 1.0.1 and normalizer-tr 0.8.1 on 2026-10-29).

Whole words only and case-insensitive; Python's matching also pairs the Turkish i letters (I, İ,
ı, i), so "İNSTAGRAM" and "Instagram" match alike. A suffix after an apostrophe stays as written
("WhatsApp'tan" -> "vatsap'tan"). One pass: a replacement is never matched again. The transcript
keeps the original text; this is pronunciation only."""
import json
import re


def fold(word):
    """The key a written word is matched by: case-folded, with the four i letters made one."""
    return word.replace("İ", "i").replace("I", "i").replace("ı", "i").casefold()


class Respeller:
    def __init__(self, table):
        if not isinstance(table, dict):
            raise ValueError("the respelling table is an object of written -> spoken")
        said = {}
        for written, spoken in table.items():
            for value in (written, spoken):
                if not isinstance(value, str) or not value or value != value.strip():
                    raise ValueError("a respelling entry is a non-empty string without outer spaces")
            if fold(written) in said:
                raise ValueError(f"the respelling table names {written!r} twice")
            said[fold(written)] = spoken
        self.table = dict(table)
        self._said = said
        self._pattern = None
        if said:
            alternatives = sorted(table, key=len, reverse=True)
            self._pattern = re.compile(
                r"(?<!\w)(" + "|".join(map(re.escape, alternatives)) + r")(?!\w)", re.IGNORECASE
            )

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            return cls(json.load(f))

    def apply(self, text):
        if self._pattern is None:
            return text
        return self._pattern.sub(lambda m: self._said.get(fold(m.group(1)), m.group(1)), text)
