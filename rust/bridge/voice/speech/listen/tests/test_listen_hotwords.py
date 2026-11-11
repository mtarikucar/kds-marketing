"""Hotwords as sherpa-onnx will read them: cleaned, cut into the model's pieces the way its
simple-sentencepiece does, and never anything its native parser could choke on."""
import math
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import hotwords  # noqa: E402
from hotwords import MARK, Vocab, clean, lower_tr, prepare, scores, vocab_text  # noqa: E402

LETTERS = list("abcçdefgğhıijklmnoöprsştuüvyzwqx")
# A toy vocabulary in rank order, as tokens.txt lists it after the special pieces.
PIECES = [MARK, *LETTERS, "▁je", "e", "ta", "▁ah", "met", "▁ahmet", "▁is", "tan", "bul", "▁istanbul", "an", "ar",
          "la", "ler", "▁ka", "ra", "▁kara", "os", "man", "oğlu", "▁yıl", "maz"]
PIECES = list(dict.fromkeys(PIECES))
VOCAB = Vocab(PIECES)


def port_of_ssentencepiece(word, pieces, score=None):
    """simple-sentencepiece 0.7's Encode, line for line, over UTF-8 bytes (GetDag, CalcDp, Cut)."""
    table = {p.encode(): s for p, s in (score or scores(pieces)).items()}
    s = (MARK + word).encode()
    n = len(s)
    route = [(0.0, 0)] * (n + 1)
    for i in range(n - 1, -1, -1):
        items = [(table[s[i:j]], j) for j in range(i + 1, n + 1) if s[i:j] in table]
        best, nxt = -math.inf, -1
        for score, j in items:
            total = score + route[j][0]
            if total > best or (total == best and nxt >= j):
                best, nxt = total, j
        route[i] = (0.0 if best == -math.inf else best, nxt)
    out, i = [], 0
    while i < n:
        if route[i][1] == -1:
            out.append("<unk>")
            i += 1
        else:
            out.append(s[i:route[i][1]].decode())
            i = route[i][1]
    return out


def test_turkish_lowercase():
    assert lower_tr("İSTANBUL") == "istanbul"
    assert lower_tr("ISPARTA") == "ısparta"


def test_the_scores_fall_with_the_rank_as_integers():
    s = scores(PIECES)
    harmonic = sum(1.0 / k for k in range(1, len(PIECES) + 1))
    assert s[MARK] == -round(1000 * math.log(harmonic))
    values = [s[p] for p in PIECES]
    assert values == sorted(values, reverse=True) and all(isinstance(v, int) for v in values)


def test_the_vocabulary_file_is_one_piece_and_score_per_line_without_the_special_pieces():
    lines = vocab_text(PIECES).splitlines()
    assert len(lines) == len(PIECES)
    for line, piece in zip(lines, PIECES):
        token, score = line.split(" ")
        assert token == piece and int(score) == scores(PIECES)[piece]
    assert not any(line.split(" ")[0] in hotwords.SPECIAL for line in lines)


def test_the_pieces_file_drops_the_special_pieces(tmp_path):
    path = tmp_path / "tokens.txt"
    path.write_text("<blk> 0\n<sos/eos> 1\n<unk> 2\n▁ 3\na 4\n▁bir 5\n", encoding="utf-8")
    assert hotwords.load_pieces(path) == [MARK, "a", "▁bir"]


def test_words_are_cut_the_way_sherpa_onnx_cuts_them():
    assert VOCAB.pieces("ahmet") == ["▁ahmet"]
    assert VOCAB.pieces("istanbul") == ["▁istanbul"]
    assert VOCAB.pieces("karaosmanoğlu") == ["▁kara", "os", "man", "oğlu"]
    for word in ["jeeta", "yılmaz", "ahmetler", "karaman", "istanbullar", "qwx"]:
        assert VOCAB.pieces(word) == port_of_ssentencepiece(word, PIECES), word
    rng = random.Random(7)
    for _ in range(500):
        word = "".join(rng.choice(LETTERS + ["an", "ar", "la", "met", "ta"]) for _ in range(rng.randint(1, 8)))
        assert VOCAB.pieces(word) == port_of_ssentencepiece(word, PIECES), word


def test_a_tie_goes_to_the_shorter_first_piece():
    # Rank scores almost never tie, so the scores are set by hand: "▁a b" and "▁ ab" both score -4.
    tied = [MARK, "a", "b", "▁a", "ab"]
    score = {MARK: -1, "a": -3, "b": -2, "▁a": -2, "ab": -3}
    v = Vocab(tied, score)
    assert v.pieces("ab") == [MARK, "ab"] == port_of_ssentencepiece("ab", tied, score)
    for word in ["ab", "aab", "abab", "ba"]:
        assert v.pieces(word) == port_of_ssentencepiece(word, tied, score), word


def test_a_word_with_a_character_the_vocabulary_lacks_has_no_pieces():
    assert VOCAB.pieces("señor") is None


def test_hotwords_are_cleaned_to_the_models_words():
    assert clean("Jeeta", VOCAB) == "jeeta"
    assert clean("  Ahmet   Yılmaz ", VOCAB) == "ahmet yılmaz"
    assert clean("İSTANBUL", VOCAB) == "istanbul"
    assert clean("Ahmet'in", VOCAB) == "ahmetin"
    assert clean("Ali-Veli", VOCAB) == "ali veli"
    assert clean("Hâlâ", VOCAB) == "hala"
    assert clean("Ayşe\nYılmaz", VOCAB) == "ayşe yılmaz"


def test_nothing_sherpa_onnx_reads_as_a_score_a_threshold_or_a_phrase_survives():
    assert clean(":2.5", VOCAB) is None
    assert clean(":boost", VOCAB) == "boost"
    assert clean("#tag", VOCAB) == "tag"
    assert clean("@ahmet", VOCAB) == "ahmet"
    assert clean("a/b", VOCAB) == "a b"
    assert clean("<unk>", VOCAB) == "unk"


def test_a_hotword_the_model_cannot_spell_is_dropped_whole():
    assert clean("Studio 54", VOCAB) is None
    assert clean("José", VOCAB) is None
    assert clean("Ахмет", VOCAB) is None
    assert clean("", VOCAB) is None and clean("  -  ", VOCAB) is None
    assert clean(None, VOCAB) is None and clean(42, VOCAB) is None


def test_a_long_hotword_is_cut_at_forty_characters():
    assert clean("a" * 60, VOCAB) == "a" * 40


def test_prepare_joins_up_to_twenty_once_each_and_counts_the_rest():
    words, kept, dropped = prepare(["Jeeta", "JEETA", "Studio 54", "Ahmet Yılmaz", 7], VOCAB)
    assert words == "jeeta/ahmet yılmaz" and kept == 2 and dropped == 3
    many = [f"ad{'a' * n}" for n in range(30)]
    words, kept, dropped = prepare(many, VOCAB)
    assert kept == 20 and dropped == 10 and words.count("/") == 19
    assert prepare("Jeeta", VOCAB) == ("", 0, 1), "not a list: no hotwords, one dropped"
    assert prepare(None, VOCAB) == ("", 0, 0)
    assert prepare([], VOCAB) == ("", 0, 0)


def test_decomposed_letters_are_composed_first():
    assert clean("Gu\u0308mu\u0308s\u0327dere", VOCAB) == "gümüşdere"
    assert clean("I\u0307stanbul", VOCAB) == "istanbul", "a dotted capital I in two code points"
    assert clean("Ays\u0327e", VOCAB) == clean("Ayşe", VOCAB) == "ayşe"
