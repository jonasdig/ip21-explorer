import os

from ip21_explorer.config import Settings, load_env_file, write_env_setting


def test_env_file_populates_environment(tmp_path, monkeypatch):
    env_file = tmp_path / "ip21.env"
    env_file.write_text(
        "# comment line\n"
        "\n"
        "IP21_SOURCE=aspen\n"
        "IP21_ASPEN_URL='https://server/ProcessData/AtProcessDataREST.dll'\n"
        'IP21_TZ="Europe/Oslo"\n'
        "not a setting\n"
        "IP21_PORT = 9000\n"
    )
    for key in ("IP21_SOURCE", "IP21_ASPEN_URL", "IP21_TZ", "IP21_PORT"):
        monkeypatch.delenv(key, raising=False)

    load_env_file(env_file)

    assert os.environ["IP21_SOURCE"] == "aspen"
    # surrounding quotes are stripped
    assert os.environ["IP21_ASPEN_URL"] == "https://server/ProcessData/AtProcessDataREST.dll"
    assert os.environ["IP21_TZ"] == "Europe/Oslo"
    # spaces around = are tolerated
    assert os.environ["IP21_PORT"] == "9000"

    settings = Settings.from_env()
    assert settings.source == "aspen"
    assert settings.aspen_url.endswith("AtProcessDataREST.dll")


def test_real_environment_wins_over_env_file(tmp_path, monkeypatch):
    env_file = tmp_path / "ip21.env"
    env_file.write_text("IP21_SOURCE=aspen\n")
    monkeypatch.setenv("IP21_SOURCE", "sim")

    load_env_file(env_file)

    assert os.environ["IP21_SOURCE"] == "sim"


def test_write_env_setting_replaces_line_and_keeps_the_rest(tmp_path):
    env_file = tmp_path / "ip21.env"
    env_file.write_text(
        "# IP21 Explorer server configuration.\n"
        "IP21_SOURCE=aspen\n"
        "\n"
        "# Timezone the server reports timestamps in.\n"
        "IP21_TZ=Europe/Oslo\n"
    )

    write_env_setting(env_file, "IP21_TZ", "UTC")

    assert env_file.read_text() == (
        "# IP21 Explorer server configuration.\n"
        "IP21_SOURCE=aspen\n"
        "\n"
        "# Timezone the server reports timestamps in.\n"
        "IP21_TZ=UTC\n"
    )


def test_write_env_setting_appends_with_a_comment(tmp_path):
    env_file = tmp_path / "ip21.env"
    env_file.write_text("IP21_SOURCE=sim\n")

    write_env_setting(env_file, "IP21_FAVORITE_MAPS", "CA_I SP", comment="Favourites.")

    assert env_file.read_text() == (
        "IP21_SOURCE=sim\n"
        "\n"
        "# Favourites.\n"
        "IP21_FAVORITE_MAPS=CA_I SP\n"
    )


def test_write_env_setting_creates_a_missing_file(tmp_path):
    env_file = tmp_path / "nested" / "ip21.env"

    write_env_setting(env_file, "IP21_FAVORITE_MAPS", "CA_I PV,CA_I SP")

    assert env_file.read_text() == "IP21_FAVORITE_MAPS=CA_I PV,CA_I SP\n"


def test_favorite_maps_parsed_from_env(monkeypatch):
    monkeypatch.setenv("IP21_FAVORITE_MAPS", " CA_I OUTPUT , CA_I SP ,, ")
    assert Settings.from_env().favorite_maps == ["CA_I OUTPUT", "CA_I SP"]

    monkeypatch.setenv("IP21_FAVORITE_MAPS", "")
    assert Settings.from_env().favorite_maps == []


def test_desc_scan_max_defaults_and_overrides(monkeypatch):
    monkeypatch.delenv("IP21_DESC_SCAN_MAX", raising=False)
    assert Settings.from_env().desc_scan_max == 100
    monkeypatch.setenv("IP21_DESC_SCAN_MAX", "1200")
    assert Settings.from_env().desc_scan_max == 1200


def test_read_workers_defaults_and_overrides(monkeypatch):
    monkeypatch.delenv("IP21_READ_WORKERS", raising=False)
    assert Settings.from_env().read_workers == 4
    monkeypatch.setenv("IP21_READ_WORKERS", "1")
    assert Settings.from_env().read_workers == 1
