from cadgen import build123d as bd
from cadgen import step

LENGTH = 40.0
WIDTH = 30.0
THICKNESS = 10.0
HOLE = 6.0


@step(out="../STEP/part.step")
def part():
    plate = bd.Box(LENGTH, WIDTH, THICKNESS)
    hole = bd.Cylinder(HOLE / 2, THICKNESS * 2)
    return plate - hole


if __name__ == "__main__":
    part()
