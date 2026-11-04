"""The brand respelling table and its matcher. Named test_speak_* so the listen service's tests
(B3: test_session.py, test_models.py) can sit beside these in one pytest run."""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from respell import Respeller  # noqa: E402

TABLE = pathlib.Path(__file__).resolve().parents[1] / "respell.json"


def test_brands_are_respelled_with_their_suffixes_kept():
    r = Respeller({"Jeeta": "Cita", "WhatsApp": "vatsap"})
    assert r.apply("Jeeta'nın asistanıyım") == "Cita'nın asistanıyım"
    assert r.apply("WhatsApp'tan yazabilirsiniz") == "vatsap'tan yazabilirsiniz"
    assert r.apply("WhatsApp’tan yazabilirsiniz") == "vatsap’tan yazabilirsiniz"
    assert r.apply("jeeta ve whatsapp") == "Cita ve vatsap"
    assert r.apply("JEETA, Whatsapp!") == "Cita, vatsap!"


def test_words_that_merely_contain_a_brand_are_left_alone():
    r = Respeller({"Jeeta": "Cita", "Google": "gugıl"})
    assert r.apply("Jeetalar") == "Jeetalar"
    assert r.apply("jeetagrowth.com") == "jeetagrowth.com"
    assert r.apply("Googleda Jeeta2") == "Googleda Jeeta2"
    assert r.apply("SüperJeeta MyGoogle _Google") == "SüperJeeta MyGoogle _Google"


def test_the_four_turkish_i_letters_match_one_another():
    r = Respeller({"Instagram": "instagram", "TikTok": "tiktok"})
    assert r.apply("İnstagram'da") == "instagram'da"
    assert r.apply("INSTAGRAM ve TİKTOK") == "instagram ve tiktok"
    assert r.apply("ınstagram") == "instagram"
    assert r.apply("Inſtagram ve TiKTOK") == "instagram ve tiktok"  # long s, Kelvin sign


def test_one_pass_never_respells_a_replacement():
    r = Respeller({"Jeeta": "Google", "Google": "gugıl"})
    assert r.apply("Jeeta ve Google") == "Google ve gugıl"


def test_a_bad_table_is_refused():
    for table in ({"": "x"}, {"Jeeta": ""}, {" Jeeta": "Cita"}, {"Jeeta": 1}, ["Jeeta"]):
        with pytest.raises(ValueError):
            Respeller(table)
    with pytest.raises(ValueError):
        Respeller({"Jeeta": "Cita", "JEETA": "Cita"})
    assert Respeller({}).apply("Jeeta") == "Jeeta"


def test_the_shipped_table_is_the_owners():
    # Owner-given (2026-10-29). Each spelling was run through antalia-mini 1.0.1's normaliser and
    # normalizer-tr 0.8.1 (EMA's own frontend) and reached the model text unchanged; the image
    # checks it again at start (jeeta_speak.self_test). Pronunciation by ear is the owner's.
    table = Respeller.load(TABLE)
    assert table.table == {
        "Jeeta": "Cita",
        "WhatsApp": "vatsap",
        "Instagram": "instagram",
        "Facebook": "feysbuk",
        "TikTok": "tiktok",
        "Google": "gugıl",
    }
    assert table.apply("Merhaba, ben Jeeta'nın dijital asistanıyım.") == "Merhaba, ben Cita'nın dijital asistanıyım."
    assert table.apply("WhatsApp, Facebook, Instagram, TikTok ve Google'da varız.") == (
        "vatsap, feysbuk, instagram, tiktok ve gugıl'da varız."
    )
