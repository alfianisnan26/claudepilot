import sys


def test_ok():
    assert sys.version_info[:2] == (3, 11)
