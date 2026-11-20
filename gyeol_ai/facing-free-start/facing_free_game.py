"""Learn two initial placements, then use the facing placement rule."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'free-start'))

from free_game import FreeStartGame, SETUP_SIZE, RADIUS, WIDTH
from free_game import placement as setup_placement, decode_placement as setup_decode
from facing.rules import FacingGame, ACTION_SIZE as REGULAR_SIZE, SYMMETRY_MAPS, PASS_ACTION

ACTION_SIZE = REGULAR_SIZE + SETUP_SIZE


def placement(dr, dc, direction):
    return setup_placement(dr, dc, direction, REGULAR_SIZE)


def decode_placement(action):
    return setup_decode(action, REGULAR_SIZE)


class FacingFreeStartGame(FreeStartGame, FacingGame):
    regular_action_size = REGULAR_SIZE
    regular_symmetry_maps = SYMMETRY_MAPS
