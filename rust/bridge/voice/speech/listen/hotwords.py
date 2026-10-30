"""Per-call hotwords for sherpa-onnx's contextual biasing (design addendum section 6, risk 2).

sherpa-onnx 2.0.1 cuts a per-stream hotword into the model's pieces itself, by its `modeling_unit`:
"cjkchar" (its default) splits every word into single characters, so a pre-cut "▁je e ta" would be
boosted as "▁ j e e t a", a path the model never emits; "bpe" cuts each word with
simple-sentencepiece over a `piece score` vocabulary file: the best-scoring cut, a tie going to the
shorter first piece. seda-v0.1 ships tokens.txt (500 pieces of a sentencepiece unigram model, ranked
by score) but neither the model nor the scores, so `vocab_text` writes that file with a Zipf score
per rank, -1000 * ln(rank * H) with H the harmonic number of the vocabulary, as integers so both
sides add them exactly; `pieces` makes the same cut here, to check a hotword before sherpa-onnx sees
it.

What reaches sherpa-onnx must never fail to encode, and must never be read as anything but words:
its native code prints a hotword it cannot encode to stderr (no Python filter can withhold that),
and reads a word that starts with ":" or "#" as a number, aborting the process on a bad one. So
`clean` lowercases a hotword the Turkish way, folds the circumflexes, drops apostrophes, turns any
other punctuation into a space, and drops the hotword whole if a character is left that is not one
of the model's letters (a digit, say: the model writes numbers as words). Phrases are joined with "/"
as sherpa-onnx's `create_stream(hotwords)` expects.
"""
import math
import unicodedata

MARK = "▁"
MAX_HOTWORDS = 20
MAX_HOTWORD_CHARS = 40
# The special pieces that start icefall's tokens.txt; never offered as a cut.
SPECIAL = ("<blk>", "<sos/eos>", "<unk>")
APOSTROPHES = "'’ʼ`´"
FOLD = str.maketrans("âîûÂÎÛ", "aiuAIU")


def lower_tr(text):
    return text.replace("I", "ı").replace("İ", "i").lower()


def load_pieces(tokens_path):
    """The model's pieces in rank order (tokens.txt order), the special ones left out."""
    pieces = []
    with open(tokens_path, encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) == 2 and parts[0] not in SPECIAL:
                pieces.append(parts[0])
    return pieces


def scores(pieces):
    """piece -> integer score: -1000 * ln(rank * H), rank from 1, H = 1 + 1/2 + ... + 1/n."""
    harmonic = sum(1.0 / k for k in range(1, len(pieces) + 1))
    return {p: -round(1000 * math.log(rank * harmonic)) for rank, p in enumerate(pieces, start=1)}


def vocab_text(pieces):
    """The `piece score` file sherpa-onnx's bpe_vocab reads."""
    return "".join(f"{p} {s}\n" for p, s in scores(pieces).items())


class Vocab:
    """The cut sherpa-onnx makes (simple-sentencepiece 0.7, `Ssentencepiece::Encode`)."""

    def __init__(self, pieces, score=None):
        self.score = score or scores(pieces)
        self.longest = max(len(p) for p in self.score)
        self.letters = {p for p in self.score if len(p) == 1 and p.isalpha()}

    def pieces(self, word):
        """The pieces of one word, or None when a character has no piece."""
        s = MARK + word
        n = len(s)
        best = [(0, n)] * (n + 1)  # position -> (score of the rest, end of the first piece)
        for i in range(n - 1, -1, -1):
            top = None
            for end in range(i + 1, min(n, i + self.longest) + 1):
                score = self.score.get(s[i:end])
                if score is None:
                    continue
                total = score + best[end][0]
                if top is None or total > top[0] or (total == top[0] and end <= top[1]):
                    top = (total, end)
            if top is None:
                return None
            best[i] = top
        out, i = [], 0
        while i < n:
            out.append(s[i:best[i][1]])
            i = best[i][1]
        return out


def clean(hotword, vocab):
    """The hotword as sherpa-onnx may read it (lowercase words of the model's letters, single
    spaces), or None."""
    if not isinstance(hotword, str):
        return None
    # Composed first: "ş" may arrive as "s" and a combining cedilla, "İ" as "I" and a combining dot.
    text = lower_tr(unicodedata.normalize("NFC", hotword).translate(FOLD)[:MAX_HOTWORD_CHARS])
    if any(c.isnumeric() for c in text):
        return None
    text = "".join("" if c in APOSTROPHES else c if c.isalpha() else " " for c in text)
    words = text.split()
    if not words or any(c not in vocab.letters for w in words for c in w):
        return None
    if any(vocab.pieces(w) is None for w in words):
        return None
    return " ".join(words)


def prepare(hotwords, vocab):
    """(the per-stream hotwords string, how many were kept, how many were dropped). Anything but a
    list is no hotwords (one dropped, unless it was absent)."""
    if not isinstance(hotwords, list):
        return "", 0, 0 if hotwords is None else 1
    kept, seen = [], set()
    for h in hotwords[:MAX_HOTWORDS]:
        c = clean(h, vocab)
        if c is not None and c not in seen:
            seen.add(c)
            kept.append(c)
    return "/".join(kept), len(kept), len(hotwords) - len(kept)
